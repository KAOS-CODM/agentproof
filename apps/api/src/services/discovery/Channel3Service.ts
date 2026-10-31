import { z } from 'zod';
import { productSchema, type Product, type StructuredIntent } from '@agentproof/shared';
import { logger } from '../../utils/logger.js';
import { formatTransportDiagnostic } from '../../utils/transportDiagnostics.js';

const CHANNEL3_SEARCH_URL = 'https://api.trychannel3.com/v1/search';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_LIMIT = 20;

// Currencies supported by the Channel3 locale config
// (https://docs.trychannel3.com). We only send `config.currency` when the
// intent currency is one of these; otherwise we omit it and let the
// deterministic PolicyEngine reject any cross-currency comparison.
const SUPPORTED_CURRENCIES = new Set([
  'USD', 'CAD', 'AUD', 'GBP', 'EUR', 'SEK', 'CZK', 'RON',
]);

export class Channel3NotConfiguredError extends Error {
  constructor() {
    super(
      'Channel3 integration is not configured. Set CHANNEL3_API_KEY to enable live product discovery. ' +
        'Falling back is not allowed; select the demo catalog explicitly with DISCOVERY_PROVIDER=demo.',
    );
    this.name = 'Channel3NotConfiguredError';
  }
}

/** The provider returned a non-2xx HTTP response. */
export class Channel3ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'Channel3ApiError';
    this.status = status;
  }
}

/** A network/transport failure or timeout occurred before a response arrived. */
export class Channel3TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Channel3TransportError';
  }
}

/** The provider responded, but the payload did not match the documented schema. */
export class Channel3ResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Channel3ResponseError';
  }
}

// ── Wire schemas ────────────────────────────────────────────────────────────
// Defensive validation of the documented response shape before any value is
// trusted. Unknown keys are ignored by Zod; missing fields are handled during
// mapping (never fabricated).

const priceSchema = z.object({
  price: z.number(),
  currency: z.string().min(1),
  compare_at_price: z.number().nullable().optional(),
});

const offerSchema = z.object({
  url: z.string().min(1),
  domain: z.string().min(1),
  price: priceSchema,
  availability: z.enum(['InStock', 'OutOfStock']).nullable().optional(),
  condition: z.enum(['new', 'used', 'refurbished']).nullable().optional(),
  max_commission_rate: z.number().nullable().optional(),
});

const brandSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});

const imageSchema = z.object({
  url: z.string().min(1),
  cleaned_url: z.string().nullable().optional(),
  is_main_image: z.boolean().nullable().optional(),
  shot_type: z.string().nullable().optional(),
  alt_text: z.string().nullable().optional(),
});

const categoryRefSchema = z.object({
  slug: z.string(),
  title: z.string().min(1),
});

const categorySchema = z.object({
  slug: z.string(),
  title: z.string().min(1),
  path: z.array(categoryRefSchema).optional(),
  has_children: z.boolean().optional(),
});

const channel3ProductSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  brands: z.array(brandSchema).optional(),
  images: z.array(imageSchema).optional(),
  category: categorySchema.nullable().optional(),
  offers: z.array(offerSchema).optional(),
  structured_attributes: z.record(z.array(z.string())).optional(),
});

const searchResponseSchema = z.object({
  products: z.array(channel3ProductSchema),
  next_page_token: z.string().nullable().optional(),
});

type Channel3Product = z.infer<typeof channel3ProductSchema>;
type Channel3Offer = z.infer<typeof offerSchema>;

type MappingResult =
  | { ok: true; product: Product }
  | { ok: false; reason: string };

// ── Mapping helpers ─────────────────────────────────────────────────────────

/** Channel3 condition is per-offer and may be null or "refurbished". Only an
 * explicit "new"/"used" maps through; everything else is `unknown`, which the
 * PolicyEngine fails closed on for new/used intents. */
function mapCondition(raw: Channel3Offer['condition']): 'new' | 'used' | 'unknown' {
  if (raw === 'new') return 'new';
  if (raw === 'used') return 'used';
  return 'unknown';
}

/**
 * Choose one offer deterministically, without ever comparing across currencies.
 * Offers in a different currency than the intent are ignored entirely; if none
 * remain the product cannot be evaluated in the intent currency and is skipped.
 * Preference: InStock (or unknown availability) first, then lowest price, then
 * domain for a stable tie-break.
 */
function selectOffer(offers: Channel3Offer[], currency: string): Channel3Offer | null {
  const target = currency.toUpperCase();
  const inCurrency = offers.filter((o) => o.price.currency.toUpperCase() === target);
  if (inCurrency.length === 0) return null;

  return (
    [...inCurrency].sort((a, b) => {
      const aOut = a.availability === 'OutOfStock' ? 1 : 0;
      const bOut = b.availability === 'OutOfStock' ? 1 : 0;
      if (aOut !== bOut) return aOut - bOut;
      if (a.price.price !== b.price.price) return a.price.price - b.price.price;
      return a.domain.localeCompare(b.domain);
    })[0] ?? null
  );
}

/** Prefer the background-removed square image for grids, else the regular shot. */
function selectImage(images: Channel3Product['images']): string | undefined {
  const list = images ?? [];
  const main = list.find((i) => i.is_main_image) ?? list[0];
  if (!main) return undefined;
  return main.cleaned_url ?? main.url;
}

function numericValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

interface SearchBody {
  query: string;
  filters: Record<string, unknown>;
  config: Record<string, unknown>;
  limit: number;
}

function buildSearchBody(intent: StructuredIntent): SearchBody {
  // Channel3 guidance: express constraints as structured filters where
  // supported; otherwise include them in the query rather than dropping them.
  const queryParts = [intent.purpose, ...intent.brands]
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const filters: Record<string, unknown> = {
    // Channel3 defaults conditions to ["new"]; be explicit and map the intent.
    conditions: intent.condition === 'any' ? ['new', 'used'] : [intent.condition],
    availability: ['InStock'],
  };

  const price: { min_price?: number; max_price?: number } = {};
  if (Number.isFinite(intent.maxAmount) && intent.maxAmount > 0) {
    price.max_price = intent.maxAmount;
  }
  const lowerBounds = intent.constraints
    .filter((c) => c.type === 'price' && c.operator === 'gte')
    .map((c) => numericValue(c.value))
    .filter((v): v is number => v !== null);
  const upperBounds = intent.constraints
    .filter((c) => c.type === 'price' && c.operator === 'lte')
    .map((c) => numericValue(c.value))
    .filter((v): v is number => v !== null);
  if (lowerBounds.length > 0) price.min_price = Math.max(...lowerBounds);
  if (upperBounds.length > 0) {
    const cap = Math.min(...upperBounds);
    price.max_price = price.max_price === undefined ? cap : Math.min(price.max_price, cap);
  }
  if (Object.keys(price).length > 0) filters.price = price;

  const locale: Record<string, unknown> = {};
  if (SUPPORTED_CURRENCIES.has(intent.currency.toUpperCase())) {
    locale.currency = intent.currency.toUpperCase();
  }

  return { query: queryParts.join(' '), filters, config: locale, limit: DEFAULT_LIMIT };
}

/**
 * Channel3 product search adapter.
 *
 * Endpoint: `POST https://api.trychannel3.com/v1/search` (documented HTTP API).
 * Auth: `x-api-key` header, server-side only.
 * Docs: https://docs.trychannel3.com/guides/make-a-search
 *
 * The HTTP API + Zod was chosen over the official SDK because it matches this
 * codebase's existing client convention (PayPalClient / OpenRouterClient) and
 * avoids pulling a large generated SDK into the API bundle.
 *
 * This adapter discovers and normalizes products only. It makes NO
 * authorization decisions; the deterministic PolicyEngine remains the sole
 * authority for price, currency, brand, condition, and purpose.
 */
export class Channel3Service {
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly configured: boolean;

  constructor(apiKey?: string, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    // No implicit env read here: the API key must be supplied explicitly
    // (production wires it via createDiscoverySource). Keeps tests hermetic and
    // makes "no credentials" an explicit, verifiable state.
    this.apiKey = apiKey ?? '';
    this.timeoutMs = timeoutMs;
    this.configured = this.apiKey.length > 0;
  }

  async search(intent: StructuredIntent): Promise<Product[]> {
    if (!this.configured) {
      throw new Channel3NotConfiguredError();
    }

    const body = buildSearchBody(intent);

    let response: Response;
    try {
      response = await fetch(CHANNEL3_SEARCH_URL, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new Channel3TransportError(`Channel3 search timed out after ${this.timeoutMs}ms`);
      }
      const diagnostic = formatTransportDiagnostic(err);
      const base = err instanceof Error ? err.message : 'unknown error';
      throw new Channel3TransportError(`Channel3 search transport error: ${base}${diagnostic}`);
    }

    if (!response.ok) {
      // Read a bounded provider-error snippet for server-side diagnostics only.
      // Never surface it to clients and never include the API key (it travels
      // in a header, not the body).
      const preview = await response.text().catch(() => '');
      logger.warn('Channel3 search request failed', {
        status: response.status,
        bodyPreview: preview.slice(0, 300).replace(/\s+/g, ' ').trim(),
      });

      if (response.status === 401 || response.status === 403) {
        throw new Channel3ApiError(
          response.status,
          `Channel3 rejected the API key (status ${response.status}). Check CHANNEL3_API_KEY.`,
        );
      }
      if (response.status === 429) {
        throw new Channel3ApiError(response.status, 'Channel3 rate limit exceeded (status 429).');
      }
      throw new Channel3ApiError(response.status, `Channel3 search failed with status ${response.status}.`);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new Channel3ResponseError('Channel3 returned a non-JSON response');
    }

    const parsed = searchResponseSchema.safeParse(json);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || '<root>'} ${i.message}`)
        .join('; ');
      throw new Channel3ResponseError(`Channel3 response did not match the expected schema: ${detail}`);
    }

    const products: Product[] = [];
    const skipReasons: Record<string, number> = {};
    for (const raw of parsed.data.products) {
      const mapped = this.mapProduct(raw, intent);
      if (mapped.ok) {
        products.push(mapped.product);
      } else {
        skipReasons[mapped.reason] = (skipReasons[mapped.reason] ?? 0) + 1;
      }
    }

    if (products.length === 0 && parsed.data.products.length > 0) {
      logger.warn('Channel3 returned only products that could not be normalized', {
        returned: parsed.data.products.length,
        reasons: skipReasons,
      });
    } else if (Object.keys(skipReasons).length > 0) {
      logger.warn('Channel3 dropped some products during normalization', {
        skipped: Object.values(skipReasons).reduce((a, b) => a + b, 0),
        reasons: skipReasons,
      });
    }

    return products;
  }

  private mapProduct(raw: Channel3Product, intent: StructuredIntent): MappingResult {
    const offer = selectOffer(raw.offers ?? [], intent.currency);
    if (!offer) return { ok: false, reason: 'NO_OFFER_IN_INTENT_CURRENCY' };

    const brand = raw.brands?.[0];
    if (!brand) return { ok: false, reason: 'MISSING_BRAND' };

    const path = raw.category?.path;
    const categoryTitle = raw.category?.title ?? (path && path.length > 0 ? path[path.length - 1].title : undefined);
    if (!categoryTitle) return { ok: false, reason: 'MISSING_CATEGORY' };

    const candidate: Product = {
      id: `channel3:${raw.id}`,
      source: 'channel3',
      name: raw.title,
      description: raw.description ?? '',
      price: offer.price.price,
      currency: offer.price.currency,
      brand: brand.name,
      condition: mapCondition(offer.condition),
      category: categoryTitle,
      merchant: offer.domain,
      imageUrl: selectImage(raw.images),
      productUrl: offer.url,
      availability: offer.availability ?? 'Unknown',
      externalId: raw.id,
      brandId: brand.id,
      metadata: {
        provider: 'channel3',
        offerDomain: offer.domain,
        compareAtPrice: offer.price.compare_at_price ?? null,
        maxCommissionRate: offer.max_commission_rate ?? null,
        conditionRaw: offer.condition ?? null,
        structuredAttributes: raw.structured_attributes ?? {},
      },
    };

    const validated = productSchema.safeParse(candidate);
    if (!validated.success) {
      return { ok: false, reason: 'INVALID_NORMALIZED_PRODUCT' };
    }
    return { ok: true, product: validated.data };
  }
}
