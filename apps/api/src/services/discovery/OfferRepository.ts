import type { Product } from '@agentproof/shared';

/**
 * A shared, provider-owned product offer snapshot. It is intentionally
 * independent of any intent: the same offer can be discovered by many intents
 * without being duplicated or overwritten.
 */
export interface StoredOffer {
  product: Product;
  /** ISO timestamp of when this provider offer was last fetched/refreshed. */
  fetchedAt: string;
}

/**
 * Authoritative server-side store for provider product data.
 *
 * Offers are keyed by `(source, productId)`, never by product id alone: product
 * ids are provider-local and must not be assumed globally unique. The offer
 * carries only shared product data; per-intent associations live in
 * `IntentDiscoveryRepository`.
 */
export interface OfferRepository {
  /**
   * Insert or refresh the shared offer for `(product.source, product.id)`.
   * Refreshing an offer never touches per-intent discovery associations.
   */
  upsert(product: Product, meta: { fetchedAt: string }): Promise<void>;

  /** Load the shared offer for a provider + product id, or null when unknown. */
  get(source: Product['source'], productId: string): Promise<StoredOffer | null>;
}
