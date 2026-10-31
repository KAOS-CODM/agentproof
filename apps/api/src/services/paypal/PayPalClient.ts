import { config } from '../../config/env.js';
import { formatTransportDiagnostic } from '../../utils/transportDiagnostics.js';

const TOKEN_EXPIRY_SKEW_MS = 60_000;

export class PayPalError extends Error {
  status: number | null;
  debugId: string | null;

  constructor(message: string, status: number | null = null, debugId: string | null = null) {
    super(message);
    this.name = 'PayPalError';
    this.status = status;
    this.debugId = debugId;
  }
}

export class PayPalNotConfiguredError extends Error {
  constructor() {
    super('PayPal is not configured. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.');
    this.name = 'PayPalNotConfiguredError';
  }
}

export interface CreatedOrder {
  id: string;
  status: string;
  approveUrl: string | null;
  rawLinks: Array<{ rel: string; href: string }>;
}

export interface CreateOrderInput {
  amount: number;
  currency: string;
  description: string;
  invoiceId: string;
  returnUrl?: string;
  cancelUrl?: string;
}

export interface PayPalOrderDetails {
  id: string;
  status: string;
  intent: string | null;
  invoiceId: string | null;
  amount: number | null;
  currency: string | null;
}

export interface PayPalCaptureResult {
  orderId: string;
  orderStatus: string;
  captureId: string | null;
  captureStatus: string | null;
  amount: number | null;
  currency: string | null;
}

interface TokenCacheEntry {
  accessToken: string;
  expiresAt: number;
}

/**
 * Server-side PayPal REST client (Orders v2 + OAuth client credentials).
 * Talks to the real PayPal Sandbox (or configured base URL) — no local
 * simulation of PayPal financial behavior.
 */
export class PayPalClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly baseUrl: string;
  private tokenCache: TokenCacheEntry | null = null;

  constructor(
    clientId: string = config.paypalClientId,
    clientSecret: string = config.paypalClientSecret,
    baseUrl: string = config.paypalBaseUrl,
  ) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.baseUrl = baseUrl;
  }

  isConfigured(): boolean {
    return this.clientId.length > 0 && this.clientSecret.length > 0;
  }

  private async getAccessToken(): Promise<string> {
    if (!this.isConfigured()) {
      throw new PayPalNotConfiguredError();
    }

    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt) {
      return this.tokenCache.accessToken;
    }

    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw toPayPalError(err, 'OAuth token request failed');
    }

    const debugId = response.headers.get('paypal-debug-id');

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new PayPalError(
        `OAuth token request failed with status ${response.status}`,
        response.status,
        debugId,
      );
    }

    const json = (await response.json().catch(() => null)) as {
      access_token?: unknown;
      expires_in?: unknown;
    } | null;

    if (!json || typeof json.access_token !== 'string' || json.access_token.length === 0) {
      throw new PayPalError('OAuth token response malformed', response.status, debugId);
    }

    const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 0;
    this.tokenCache = {
      accessToken: json.access_token,
      expiresAt: Date.now() + expiresIn * 1000 - TOKEN_EXPIRY_SKEW_MS,
    };

    return json.access_token;
  }

  async createOrder(input: CreateOrderInput): Promise<CreatedOrder> {
    const token = await this.getAccessToken();

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v2/checkout/orders`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          intent: 'CAPTURE',
          purchase_units: [
            {
              invoice_id: input.invoiceId,
              description: input.description,
              amount: {
                currency_code: input.currency,
                value: input.amount.toFixed(2),
              },
            },
          ],
          ...(input.returnUrl || input.cancelUrl
            ? {
                application_context: {
                  ...(input.returnUrl ? { return_url: input.returnUrl } : {}),
                  ...(input.cancelUrl ? { cancel_url: input.cancelUrl } : {}),
                },
              }
            : {}),
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw toPayPalError(err, 'Create order request failed');
    }

    const debugId = response.headers.get('paypal-debug-id');

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new PayPalError(
        `Create order failed with status ${response.status}: ${safeTruncate(body)}`,
        response.status,
        debugId,
      );
    }

    const json = (await response.json().catch(() => null)) as {
      id?: unknown;
      status?: unknown;
      links?: unknown;
    } | null;

    if (!json || typeof json.id !== 'string' || typeof json.status !== 'string') {
      throw new PayPalError('Create order response malformed', response.status, debugId);
    }

    const links = Array.isArray(json.links)
      ? (json.links as Array<{ rel?: unknown; href?: unknown }>)
          .filter((l) => typeof l.rel === 'string' && typeof l.href === 'string')
          .map((l) => ({ rel: l.rel as string, href: l.href as string }))
      : [];

    const approve = links.find((l) => l.rel === 'approve');

    return { id: json.id, status: json.status, approveUrl: approve?.href ?? null, rawLinks: links };
  }

  async getOrder(orderId: string): Promise<PayPalOrderDetails> {
    const token = await this.getAccessToken();

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v2/checkout/orders/${encodeURIComponent(orderId)}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw toPayPalError(err, 'Get order request failed');
    }

    const debugId = response.headers.get('paypal-debug-id');

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new PayPalError(`Get order failed with status ${response.status}: ${safeTruncate(body)}`, response.status, debugId);
    }

    const json = (await response.json().catch(() => null)) as {
      id?: unknown;
      status?: unknown;
      intent?: unknown;
      purchase_units?: unknown;
    } | null;

    if (!json || typeof json.id !== 'string' || typeof json.status !== 'string') {
      throw new PayPalError('Get order response malformed', response.status, debugId);
    }

    const unit = Array.isArray(json.purchase_units)
      ? (json.purchase_units[0] as { invoice_id?: unknown; amount?: { currency_code?: unknown; value?: unknown } } | undefined)
      : undefined;
    const amountValue = unit?.amount?.value;
    const amount = typeof amountValue === 'string' ? parseFloat(amountValue) : NaN;

    return {
      id: json.id,
      status: json.status,
      intent: typeof json.intent === 'string' ? json.intent : null,
      invoiceId: unit && typeof unit.invoice_id === 'string' ? unit.invoice_id : null,
      amount: Number.isFinite(amount) ? amount : null,
      currency: unit && typeof unit.amount?.currency_code === 'string' ? unit.amount.currency_code : null,
    };
  }

  async captureOrder(orderId: string): Promise<PayPalCaptureResult> {
    const token = await this.getAccessToken();

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: '{}',
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw toPayPalError(err, 'Capture request failed');
    }

    const debugId = response.headers.get('paypal-debug-id');

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new PayPalError(`Capture failed with status ${response.status}: ${safeTruncate(body)}`, response.status, debugId);
    }

    const json = (await response.json().catch(() => null)) as {
      id?: unknown;
      status?: unknown;
      purchase_units?: unknown;
    } | null;

    if (!json || typeof json.id !== 'string' || typeof json.status !== 'string') {
      throw new PayPalError('Capture response malformed', response.status, debugId);
    }

    const unit = Array.isArray(json.purchase_units)
      ? (json.purchase_units[0] as { payments?: { captures?: unknown } } | undefined)
      : undefined;
    const captures = unit?.payments?.captures;
    const capture = Array.isArray(captures)
      ? (captures[0] as { id?: unknown; status?: unknown; amount?: { currency_code?: unknown; value?: unknown } } | undefined)
      : undefined;
    const amountValue = capture?.amount?.value;
    const amount = typeof amountValue === 'string' ? parseFloat(amountValue) : NaN;

    return {
      orderId: json.id,
      orderStatus: json.status,
      captureId: capture && typeof capture.id === 'string' ? capture.id : null,
      captureStatus: capture && typeof capture.status === 'string' ? capture.status : null,
      amount: Number.isFinite(amount) ? amount : null,
      currency: capture && typeof capture.amount?.currency_code === 'string' ? capture.amount.currency_code : null,
    };
  }
}

function safeTruncate(s: string): string {
  return s.length > 500 ? `${s.slice(0, 500)}…` : s;
}

function toPayPalError(err: unknown, prefix: string): PayPalError {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return new PayPalError(`${prefix}: request timed out`);
  }
  if (err instanceof PayPalError) return err;
  // Diagnostic-only: append safe transport identifiers (name, cause.code,
  // cause.syscall, cause.hostname) without changing the error type, status,
  // or the base message. HTTP/auth rejections never reach this path.
  const message = err instanceof Error ? err.message : 'unknown error';
  return new PayPalError(`${prefix}: ${message}${formatTransportDiagnostic(err)}`);
}
