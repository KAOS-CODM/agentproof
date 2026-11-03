import type {
  StructuredIntent,
  Product,
  PolicyEvaluation,
  EvidenceRecord,
  FinancialState,
  OfferSnapshotView,
  Transaction,
} from '@agentproof/shared';

// ── Response types ──────────────────────────────────────────────────────────

export interface HealthResponse {
  status: string;
  service: string;
  timestamp: string;
}

export interface IntentResponse {
  id: string;
  rawInput: string;
  structured: StructuredIntent;
  status: string;
  createdAt: string;
}

export interface DiscoverCandidate {
  product: Product;
  evaluation: PolicyEvaluation;
  /** Immutable offer snapshot captured for this intent; absent on legacy rows. */
  snapshot?: OfferSnapshotView | null;
  /** Server-derived: the snapshot exists and is within the freshness window. */
  snapshotFresh?: boolean;
  /** Server-derived: a fresh snapshot exists and the handoff feature is enabled. */
  handoffEligible?: boolean;
}

export interface DiscoverResponse {
  intentId: string;
  candidates: DiscoverCandidate[];
  allowed: DiscoverCandidate[];
  rejected: DiscoverCandidate[];
  aiRecommendation: unknown;
  finalEvaluation: PolicyEvaluation | null;
  selectedProduct: Product | null;
  decision: string;
  confirmationRequired: boolean;
  failureReason: string | null;
  /** True when this result was reconstructed from persisted discovery state. */
  restored?: boolean;
  /** Saved associations whose policy evaluation could not be loaded. */
  missingEvaluations?: number;
  /** Server-controlled feature flag; absent/false means no handoff action. */
  handoffEnabled?: boolean;
}

export interface RetailerHandoffResponse {
  url: string;
  disclosure: string;
  offer: OfferSnapshotView;
}

export interface CreateOrderResponse {
  transactionId: string;
  financialState: FinancialState;
  paypal: {
    orderId: string;
    status: string;
    approveUrl: string;
  };
  evaluation: PolicyEvaluation;
  confirmationRequired: boolean;
}

export interface CaptureResponse {
  transactionId: string;
  financialState: FinancialState;
  reconciled?: boolean;
  alreadyCompleted?: boolean;
  evidenceIncomplete?: boolean;
  evidenceStatus?: 'RECOVERY_PENDING';
  paypal?: {
    orderId: string;
    orderStatus: string;
    captureId: string | null;
    captureStatus: string | null;
    amount: number | null;
    currency: string | null;
  };
}

export interface AuthUser {
  id: string;
  email: string;
}

export interface SessionResponse {
  user: AuthUser;
  expiresAt: string;
}

export interface LoginResponse {
  user: AuthUser;
  expiresAt: string;
}

/**
 * Browser-safe projection of a persisted offer selection.
 *
 * `userId` is intentionally absent from the server response. Price and currency
 * are the values bound from the immutable snapshot when the selection was made,
 * so they can differ from the current shared product record.
 */
export interface SelectionView {
  id: string;
  intentId: string;
  snapshotId: string;
  source: Product['source'];
  productId: string;
  price: number;
  currency: string;
  isActive: boolean;
  selectedAt: string;
  supersededAt: string | null;
}

export interface ActiveSelectionResponse {
  selection: SelectionView | null;
}

export interface SelectionHistoryResponse {
  selections: SelectionView[];
}

export interface CreateSelectionResponse {
  selection: SelectionView;
  evidenceRecorded: boolean;
  evidenceError?: string | null;
}

// ── Session-expiry notification ────────────────────────────────────────────

type SessionExpiredHandler = () => void;
let sessionExpiredHandler: SessionExpiredHandler | null = null;

/**
 * Register one listener that is notified when an authenticated request returns
 * 401. Login and the initial session probe are excluded so a normal signed-out
 * state is not reported as an expired session.
 */
export function setSessionExpiredHandler(handler: SessionExpiredHandler | null): void {
  sessionExpiredHandler = handler;
}

// ── API error ───────────────────────────────────────────────────────────────

export class ApiError extends Error {
  status: number;
  details: string;
  /** Stable machine-readable code returned by the API, when present. */
  code: string | null;

  constructor(message: string, status: number, details?: string, code: string | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details ?? '';
    this.code = code;
  }
}

// ── Helper ──────────────────────────────────────────────────────────────────

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  // Use VITE_API_URL as base when set (production); fall back to relative paths
  // so the existing Vite proxy continues working for local development.
  const base = import.meta.env.VITE_API_URL || '';
  const res = await fetch(base + path, {
    // Session cookies are HttpOnly and must be sent with every API request.
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (!res.ok) {
    if (res.status === 401 && path !== '/api/v1/auth/login' && path !== '/api/v1/auth/session') {
      sessionExpiredHandler?.();
    }
    const msg =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `Request failed with status ${res.status}`;
    const details =
      body && typeof body === 'object' && 'details' in body
        ? String((body as { details: unknown }).details)
        : '';
    const code =
      body &&
      typeof body === 'object' &&
      'code' in body &&
      typeof (body as { code: unknown }).code === 'string'
        ? (body as { code: string }).code
        : null;
    throw new ApiError(msg, res.status, details, code);
  }

  return body as T;
}

// ── Endpoints ───────────────────────────────────────────────────────────────

export function getHealth(): Promise<HealthResponse> {
  return request<HealthResponse>('/health');
}

export function login(email: string, password: string): Promise<LoginResponse> {
  return request<LoginResponse>('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export function logout(): Promise<void> {
  return request<void>('/api/v1/auth/logout', { method: 'POST' });
}

export function getSession(): Promise<SessionResponse> {
  return request<SessionResponse>('/api/v1/auth/session');
}

export function createIntent(rawInput: string): Promise<IntentResponse> {
  return request<IntentResponse>('/api/v1/intent', {
    method: 'POST',
    body: JSON.stringify({ rawInput }),
  });
}

export function getIntent(intentId: string): Promise<IntentResponse> {
  return request<IntentResponse>(`/api/v1/intent/${encodeURIComponent(intentId)}`);
}

export function listIntents(limit = 25): Promise<IntentResponse[]> {
  return request<IntentResponse[]>(`/api/v1/intent?limit=${encodeURIComponent(limit)}`);
}

export function discoverProducts(intentId: string): Promise<DiscoverResponse> {
  return request<DiscoverResponse>('/api/v1/products/discover', {
    method: 'POST',
    body: JSON.stringify({ intentId }),
  });
}

/** Reconstruct the saved discovery/policy state for one owned intent. */
export function getDiscoveries(intentId: string): Promise<DiscoverResponse> {
  return request<DiscoverResponse>(
    `/api/v1/products/discoveries/${encodeURIComponent(intentId)}`,
  );
}

/**
 * Request an explicit, owner-scoped retailer handoff. The server resolves the
 * URL from the immutable snapshot and validates it; the browser never supplies
 * the destination.
 */
export function requestRetailerHandoff(
  intentId: string,
  offer: Pick<OfferSnapshotView, 'id' | 'source' | 'productId'>,
): Promise<RetailerHandoffResponse> {
  return request<RetailerHandoffResponse>('/api/v1/products/handoff', {
    method: 'POST',
    body: JSON.stringify({
      intentId,
      source: offer.source,
      productId: offer.productId,
      snapshotId: offer.id,
    }),
  });
}

/**
 * Read the active persisted selection for an owned intent. A null selection is
 * a valid answer: it means no choice has been recorded, not that the read
 * failed.
 */
export function getActiveSelection(intentId: string): Promise<ActiveSelectionResponse> {
  return request<ActiveSelectionResponse>(
    `/api/v1/selections/${encodeURIComponent(intentId)}`,
  );
}

/** Full selection history for an owned intent, newest first. */
export function getSelectionHistory(intentId: string): Promise<SelectionHistoryResponse> {
  return request<SelectionHistoryResponse>(
    `/api/v1/selections/${encodeURIComponent(intentId)}/history`,
  );
}

/**
 * Persist an explicit user choice. The browser names the exact snapshot it
 * displayed; the server resolves that owner-scoped row and binds its stored
 * price and currency. The snapshot id is identity, never price/currency input.
 */
export function createSelection(
  intentId: string,
  source: SelectionView['source'],
  productId: string,
  snapshotId: string,
): Promise<CreateSelectionResponse> {
  return request<CreateSelectionResponse>('/api/v1/selections', {
    method: 'POST',
    body: JSON.stringify({ intentId, source, productId, snapshotId }),
  });
}

export function createOrder(
  intentId: string,
  productId: string,
  confirmationApproved: boolean,
): Promise<CreateOrderResponse> {
  return request<CreateOrderResponse>('/api/v1/payments/create-order', {
    method: 'POST',
    body: JSON.stringify({ intentId, productId, confirmationApproved }),
  });
}

export function capturePayment(transactionId: string): Promise<CaptureResponse> {
  return request<CaptureResponse>('/api/v1/payments/capture', {
    method: 'POST',
    body: JSON.stringify({ transactionId }),
  });
}

export function listTransactions(
  intentId?: string,
  limit = 25,
): Promise<Transaction[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (intentId) params.set('intentId', intentId);
  return request<Transaction[]>(`/api/v1/payments/history?${params.toString()}`);
}

export function getEvidenceByTransaction(transactionId: string): Promise<EvidenceRecord[]> {
  return request<EvidenceRecord[]>(`/api/v1/evidence?transactionId=${encodeURIComponent(transactionId)}`);
}

export function getEvidenceByIntent(intentId: string): Promise<EvidenceRecord[]> {
  return request<EvidenceRecord[]>(`/api/v1/evidence?intentId=${encodeURIComponent(intentId)}`);
}

export interface TransactionLookup {
  transactionId: string;
  intentId: string;
  financialState: FinancialState;
  amount: number;
  currency: string;
}

export function getTransactionByPaypalOrderId(orderId: string): Promise<TransactionLookup> {
  return request<TransactionLookup>(`/api/v1/payments/by-order/${encodeURIComponent(orderId)}`);
}

export function register(email: string, password: string): Promise<SessionResponse> {
  return request<SessionResponse>('/api/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}
