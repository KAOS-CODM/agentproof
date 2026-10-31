import type { Product } from '@agentproof/shared';
import type { DiscoveryDecision } from './IntentDiscoveryRepository.js';
import type { OfferSnapshot } from './OfferSnapshot.js';

/**
 * A server-side snapshot returned to the resolver. The `product` is the exact,
 * fully-mapped offer that discovery produced - never a value supplied by a
 * client.
 */
export interface StoredProduct {
  product: Product;
  /**
   * ISO timestamp used for freshness. For an intent-specific read this is the
   * discovery timestamp; for a shared-offer read it is the offer fetch time.
   */
  discoveredAt: string;
  /** The intent this product was discovered for, or null for an offer-only read. */
  discoveredForIntentId: string | null;
}

/**
 * A persisted per-intent discovery joined to its shared offer. The association
 * (including the policy decision) is what makes a saved workflow refresh-safe:
 * the exact product snapshot and the evaluation that authorized it can be read
 * back without re-running discovery.
 */
export interface IntentDiscoveredProduct {
  product: Product;
  discoveredAt: string;
  evaluationId: string | null;
  decision: DiscoveryDecision | null;
  confirmationRequired: boolean | null;
  /**
   * Immutable offer snapshot captured when this intent discovered the product.
   * Null for legacy associations written before snapshots existed.
   */
  snapshot: OfferSnapshot | null;
}

/** Metadata captured alongside a discovered product. */
export interface ProductUpsertMeta {
  discoveredAt: string;
  discoveredForIntentId?: string | null;
  /** Policy evaluation that produced the discovery, when known. */
  evaluationId?: string | null;
  decision?: DiscoveryDecision | null;
  confirmationRequired?: boolean | null;
  /**
   * Trusted owner for the immutable snapshot. Supplied by the route from the
   * authenticated session, never from a request body.
   */
  userId?: string | null;
}

/**
 * Facade over the shared offer store and the per-intent discovery store.
 *
 * Callers persist a discovered product once and may read either the shared
 * offer or the offer joined to a specific intent's discovery association. The
 * two concepts are stored independently so one intent can never clobber
 * another's discovery.
 *
 * This remains deliberately dumb storage: it never authorizes anything and
 * never invents fields - the deterministic PolicyEngine remains the sole
 * authority for price, currency, brand, condition, and purpose.
 */
export interface ProductRepository {
  /**
   * Persist/refresh the shared offer and, when `discoveredForIntentId` is
   * supplied, the independent association for that intent. A re-discovery of
   * the same intent/product updates that association; it never affects another
   * intent's association.
   */
  upsert(product: Product, meta: ProductUpsertMeta): Promise<void>;

  /**
   * Load the shared offer by provider identity + product id. Product ids are
   * provider-local, so the source is always required.
   */
  getOffer(source: Product['source'], productId: string): Promise<StoredProduct | null>;

  /**
   * Load the offer together with the discovery association for one intent.
   * Returns null when the product was not discovered for that intent (including
   * when the offer itself is unknown).
   */
  getForIntent(
    intentId: string,
    source: Product['source'],
    productId: string,
  ): Promise<StoredProduct | null>;

  /**
   * Load every product discovered for one intent, most recent first, joined to
   * its shared offer and immutable offer snapshot. The repository is dumb
   * storage: callers MUST first verify that the authenticated user owns
   * `intentId`; result rows carry no owner.
   *
   * When `userId` is supplied, only snapshots owned by that user are attached;
   * a legacy or mismatched snapshot is returned as null rather than substituted.
   */
  listForIntent(intentId: string, userId?: string): Promise<IntentDiscoveredProduct[]>;

  /**
   * Load the immutable snapshot associated with one owned intent/product
   * discovery. Returns null for an unknown association, a legacy association
   * with no snapshot, or a snapshot owned by a different user.
   */
  getSnapshotForIntent(
    intentId: string,
    source: Product['source'],
    productId: string,
    userId: string,
  ): Promise<OfferSnapshot | null>;

  /**
   * Load one immutable snapshot by its exact id for one owner.
   *
   * Ownership is enforced by the implementation: a snapshot owned by another
   * user is indistinguishable from a missing snapshot (both return null), so
   * this lookup cannot leak another user's data. Callers that bind a decision
   * to a persisted selection MUST use this exact-id read rather than the
   * mutable discovery association, so a later re-discovery cannot redirect the
   * decision to a different snapshot.
   */
  getSnapshotById(snapshotId: string, userId: string): Promise<OfferSnapshot | null>;
}
