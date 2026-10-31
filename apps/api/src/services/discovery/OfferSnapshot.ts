import type { OfferSnapshotView, Product } from '@agentproof/shared';
import { generateId } from '../../utils/id.js';

/**
 * Full, server-only offer snapshot.
 *
 * The snapshot is written once per discovery for one intent and never updated.
 * `offerUrl` is the exact URL returned by the trusted discovery provider; it is
 * deliberately not exposed by discovery endpoints, only by the explicit
 * retailer-handoff endpoint after ownership and URL validation.
 */
export interface OfferSnapshot {
  id: string;
  /** Trusted owner supplied by the authenticated request, never the client body. */
  userId: string | null;
  intentId: string;
  source: Product['source'];
  productId: string;
  externalProductId: string | null;
  productName: string;
  brand: string;
  offerUrl: string | null;
  merchant: string | null;
  price: number;
  currency: string;
  availability: NonNullable<Product['availability']> | null;
  condition: Product['condition'] | null;
  compareAtPrice: number | null;
  maxCommissionRate: number | null;
  capturedAt: string;
}

export interface CreateOfferSnapshotMeta {
  intentId: string;
  userId: string | null;
  capturedAt: string;
}

/**
 * Apply the project's existing product-freshness window to an offer snapshot.
 * A future timestamp is tolerated only within a small clock-skew allowance.
 */
export function isOfferSnapshotFresh(
  capturedAt: string,
  nowMs: number,
  maxAgeMs: number,
): boolean {
  const capturedMs = Date.parse(capturedAt);
  if (!Number.isFinite(capturedMs)) return false;
  const age = nowMs - capturedMs;
  return age >= -5 * 60 * 1000 && age <= maxAgeMs;
}

/** Insert-only store for immutable offer snapshots. */
export interface OfferSnapshotStore {
  create(snapshot: OfferSnapshot): Promise<void>;
  getById(id: string): Promise<OfferSnapshot | null>;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Build an immutable snapshot from a normalized product returned by discovery.
 *
 * Missing optional values remain null; nothing is fabricated. `max_commission_rate`
 * is preserved only as a provider-reported maximum, never as a guaranteed rate.
 */
export function createOfferSnapshot(
  product: Product,
  meta: CreateOfferSnapshotMeta,
): OfferSnapshot {
  const providerMetadata = product.metadata ?? {};
  const merchant = product.merchant ?? stringOrNull(providerMetadata.offerDomain);

  return {
    id: generateId(),
    userId: meta.userId,
    intentId: meta.intentId,
    source: product.source,
    productId: product.id,
    externalProductId: product.externalId ?? null,
    productName: product.name,
    brand: product.brand,
    offerUrl: product.productUrl ?? null,
    merchant,
    price: product.price,
    currency: product.currency,
    availability: product.availability ?? null,
    condition: product.condition,
    compareAtPrice: numberOrNull(providerMetadata.compareAtPrice),
    maxCommissionRate: numberOrNull(providerMetadata.maxCommissionRate),
    capturedAt: meta.capturedAt,
  };
}

/** Browser-safe projection: everything except the raw outbound URL and owner id. */
export function toOfferSnapshotView(snapshot: OfferSnapshot): OfferSnapshotView {
  return {
    id: snapshot.id,
    source: snapshot.source,
    productId: snapshot.productId,
    externalProductId: snapshot.externalProductId,
    productName: snapshot.productName,
    brand: snapshot.brand,
    merchant: snapshot.merchant,
    price: snapshot.price,
    currency: snapshot.currency,
    availability: snapshot.availability,
    condition: snapshot.condition,
    compareAtPrice: snapshot.compareAtPrice,
    maxCommissionRate: snapshot.maxCommissionRate,
    capturedAt: snapshot.capturedAt,
  };
}
