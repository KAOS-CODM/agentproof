import { productSchema, type Product, type StructuredIntent } from '@agentproof/shared';
import type { ProductRepository } from './ProductRepository.js';
import type { ProductSource } from './ProductDiscoveryService.js';
import { createDiscoverySource, resolveDiscoveryProvider, type DiscoveryProvider } from './discoverySource.js';

/**
 * How long a discovered product snapshot stays authoritative. Beyond this a
 * snapshot's price/offer may no longer reflect reality, so it fails closed
 * and the client must re-run discovery.
 */
export const DEFAULT_PRODUCT_MAX_AGE_MS = 60 * 60 * 1000;

export type ProductResolution =
  | { kind: 'RESOLVED'; product: Product }
  | { kind: 'NOT_FOUND' }
  /** A stored snapshot exists but is older than the freshness window. */
  | { kind: 'STALE' }
  /** A stored snapshot exists but is corrupt/incomplete and cannot be trusted. */
  | { kind: 'UNUSABLE' }
  /** A stored snapshot exists but was discovered for a different intent. */
  | { kind: 'NOT_FOR_INTENT' };

export interface ProductResolutionDeps {
  repository: ProductRepository;
  /**
   * Provider identity the resolved product must belong to. Product ids are
   * provider-local, so resolution is always scoped to the active source.
   */
  source: Product['source'];
  /**
   * The demo catalog, supplied ONLY when DISCOVERY_PROVIDER=demo. When absent
   * (the live provider), there is no catalog fallback: an unknown id is simply
   * not found. This is what prevents a silent fallback to demo data.
   */
  demoCatalog?: ProductSource;
  maxAgeMs?: number;
  now?: () => number;
}

/**
 * Resolves a product id to the authoritative, server-side offer snapshot.
 *
 * Clients never supply price, currency, merchant, condition, or URL: they only
 * reference an id, and the offer is loaded from trusted server-side state (or,
 * for the explicitly-selected demo provider, from its in-memory catalog).
 * Resolution is not authorization - the PolicyEngine still gates the result.
 */
export class ProductResolutionService {
  private readonly repository: ProductRepository;
  private readonly source: Product['source'];
  private readonly demoCatalog?: ProductSource;
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(deps: ProductResolutionDeps) {
    this.repository = deps.repository;
    this.source = deps.source;
    this.demoCatalog = deps.demoCatalog;
    this.maxAgeMs = deps.maxAgeMs ?? DEFAULT_PRODUCT_MAX_AGE_MS;
    this.now = deps.now ?? (() => Date.now());
  }

  async resolve(
    intentId: string,
    intent: StructuredIntent,
    productId: string,
  ): Promise<ProductResolution> {
    // Read the offer joined to THIS intent's discovery association. A product
    // discovered only for another intent therefore never resolves here.
    const stored = await this.repository.getForIntent(intentId, this.source, productId);

    if (stored) {
      // Never trust the stored row blindly: it must still satisfy the shared
      // product contract, must belong to this intent, and must be fresh.
      const parsed = productSchema.safeParse(stored.product);
      if (!parsed.success) return { kind: 'UNUSABLE' };
      if (stored.discoveredForIntentId !== null && stored.discoveredForIntentId !== intentId) {
        return { kind: 'NOT_FOR_INTENT' };
      }
      if (!this.isFresh(stored.discoveredAt)) return { kind: 'STALE' };
      return { kind: 'RESOLVED', product: parsed.data };
    }

    // The shared offer exists but this intent never discovered it.
    const offer = await this.repository.getOffer(this.source, productId);
    if (offer) return { kind: 'NOT_FOR_INTENT' };

    // No persisted offer. Only the explicitly-configured demo provider may
    // resolve from its own catalog; the live provider never substitutes demo
    // products (and vice versa).
    if (this.demoCatalog) {
      const products = await this.demoCatalog.search(intent);
      const product = products.find((p) => p.id === productId);
      if (product) {
        const parsed = productSchema.safeParse(product);
        return parsed.success
          ? { kind: 'RESOLVED', product: parsed.data }
          : { kind: 'UNUSABLE' };
      }
    }

    return { kind: 'NOT_FOUND' };
  }

  private isFresh(discoveredAt: string): boolean {
    const timestamp = Date.parse(discoveredAt);
    if (Number.isNaN(timestamp)) return false; // malformed → fail closed
    return this.now() - timestamp <= this.maxAgeMs;
  }
}

/**
 * Build the resolver from an already-constructed product repository and the
 * active discovery provider.
 *
 * The demo catalog is attached only for the explicit `demo` provider; for the
 * live provider (the default) no fallback source exists. The repository itself
 * is supplied by the composition layer so this factory never reaches for a
 * global database handle.
 */
export function createProductResolutionService(
  repository: ProductRepository,
  provider: DiscoveryProvider = resolveDiscoveryProvider(),
): ProductResolutionService {
  return new ProductResolutionService({
    repository,
    source: provider === 'demo' ? 'demo_catalog' : 'channel3',
    demoCatalog: provider === 'demo' ? createDiscoverySource('demo') : undefined,
  });
}
