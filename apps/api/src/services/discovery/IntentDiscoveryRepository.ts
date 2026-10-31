import type { Product } from '@agentproof/shared';

export type DiscoveryDecision = 'ALLOW' | 'DENY';

/**
 * The association between one intent and one discovered provider product.
 *
 * This is deliberately separate from the shared offer so that discovering the
 * same provider product for another intent cannot overwrite the first intent's
 * association. The existing application has no user/ownership concept, so no
 * `userId` is stored or invented here.
 */
export interface IntentDiscovery {
  intentId: string;
  /** Provider identity (`Product.source`); part of the product key. */
  source: Product['source'];
  productId: string;
  /** ISO timestamp of when this intent discovered this product. */
  discoveredAt: string;
  /** The policy evaluation that approved/denied this discovery, when known. */
  evaluationId: string | null;
  decision: DiscoveryDecision | null;
  confirmationRequired: boolean | null;
  /**
   * The immutable offer snapshot captured for this association's latest
   * discovery. Optional only for backward compatibility with legacy callers;
   * persisted rows always normalize it to string | null.
   */
  snapshotId?: string | null;
}

/**
 * Store for per-intent discovery associations.
 *
 * The unique association key is `(intentId, source, productId)`. Re-discovery
 * for the same intent is an idempotent update of that association; a different
 * intent always gets its own independent record.
 */
export interface IntentDiscoveryRepository {
  /** Insert or update the association for `(intentId, source, productId)`. */
  upsert(discovery: IntentDiscovery): Promise<void>;

  /** Load one intent/product association, or null when it does not exist. */
  get(
    intentId: string,
    source: Product['source'],
    productId: string,
  ): Promise<IntentDiscovery | null>;

  /** Load an intent's discoveries, most recent first. */
  listByIntent(intentId: string): Promise<IntentDiscovery[]>;
}
