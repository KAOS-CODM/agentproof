import type { Product } from '@agentproof/shared';
import type { IntentDiscoveryRepository } from './IntentDiscoveryRepository.js';
import type { OfferRepository } from './OfferRepository.js';
import {
  createOfferSnapshot,
  type OfferSnapshot,
  type OfferSnapshotStore,
} from './OfferSnapshot.js';
import type {
  IntentDiscoveredProduct,
  ProductRepository,
  ProductUpsertMeta,
  StoredProduct,
} from './ProductRepository.js';

/**
 * Backend-agnostic facade that keeps shared offers, immutable per-intent offer
 * snapshots, and per-intent discoveries in independent stores.
 *
 * Ordering: the shared offer is written first, then a new immutable snapshot,
 * then the discovery association. There is deliberately no cross-collection
 * transaction. If a later write fails, the earlier (harmless) rows remain and
 * the error propagates so the caller surfaces a failed persistence rather than
 * a false success.
 */
export class CompositeProductRepository implements ProductRepository {
  constructor(
    private readonly offers: OfferRepository,
    private readonly snapshots: OfferSnapshotStore,
    private readonly discoveries: IntentDiscoveryRepository,
  ) {}

  async upsert(product: Product, meta: ProductUpsertMeta): Promise<void> {
    await this.offers.upsert(product, { fetchedAt: meta.discoveredAt });

    const intentId = meta.discoveredForIntentId ?? null;
    if (intentId === null) return;

    // Insert-only snapshot: a refresh of the shared offer or a discovery for
    // another intent can never rewrite this intent's historical offer.
    const snapshot = createOfferSnapshot(product, {
      intentId,
      userId: meta.userId ?? null,
      capturedAt: meta.discoveredAt,
    });
    await this.snapshots.create(snapshot);

    await this.discoveries.upsert({
      intentId,
      source: product.source,
      productId: product.id,
      discoveredAt: meta.discoveredAt,
      evaluationId: meta.evaluationId ?? null,
      decision: meta.decision ?? null,
      confirmationRequired: meta.confirmationRequired ?? null,
      snapshotId: snapshot.id,
    });
  }

  async getOffer(source: Product['source'], productId: string): Promise<StoredProduct | null> {
    const offer = await this.offers.get(source, productId);
    if (!offer) return null;
    return {
      product: offer.product,
      discoveredAt: offer.fetchedAt,
      discoveredForIntentId: null,
    };
  }

  async getForIntent(
    intentId: string,
    source: Product['source'],
    productId: string,
  ): Promise<StoredProduct | null> {
    const discovery = await this.discoveries.get(intentId, source, productId);
    if (!discovery) return null;

    const offer = await this.offers.get(source, productId);
    if (!offer) return null;

    return {
      product: offer.product,
      discoveredAt: discovery.discoveredAt,
      discoveredForIntentId: intentId,
    };
  }

  async listForIntent(
    intentId: string,
    userId?: string,
  ): Promise<IntentDiscoveredProduct[]> {
    const discoveries = await this.discoveries.listByIntent(intentId);
    const discovered = await Promise.all(
      discoveries.map(async (discovery) => {
        const offer = await this.offers.get(discovery.source, discovery.productId);
        if (!offer) return null;
        const snapshot = discovery.snapshotId
          ? await this.snapshots.getById(discovery.snapshotId)
          : null;
        return {
          product: offer.product,
          discoveredAt: discovery.discoveredAt,
          evaluationId: discovery.evaluationId,
          decision: discovery.decision,
          confirmationRequired: discovery.confirmationRequired,
          // Do not attach an ownerless or foreign snapshot to an authenticated
          // caller's restored workflow.
          snapshot:
            snapshot && (userId === undefined || snapshot.userId === userId)
              ? snapshot
              : null,
        } satisfies IntentDiscoveredProduct;
      }),
    );
    return discovered.filter(
      (entry): entry is IntentDiscoveredProduct => entry !== null,
    );
  }

  async getSnapshotForIntent(
    intentId: string,
    source: Product['source'],
    productId: string,
    userId: string,
  ): Promise<OfferSnapshot | null> {
    const discovery = await this.discoveries.get(intentId, source, productId);
    if (!discovery?.snapshotId) return null;

    const snapshot = await this.snapshots.getById(discovery.snapshotId);
    if (!snapshot) return null;

    // Defense in depth: the snapshot must belong to the same owner, intent,
    // provider, and product as the association that referenced it.
    if (
      snapshot.userId !== userId ||
      snapshot.intentId !== intentId ||
      snapshot.source !== source ||
      snapshot.productId !== productId
    ) {
      return null;
    }
    return snapshot;
  }

  /**
   * Owner-scoped exact-id read over the immutable snapshot store. A snapshot
   * owned by another user is returned as null rather than exposed, so callers
   * cannot distinguish "missing" from "not yours".
   */
  async getSnapshotById(
    snapshotId: string,
    userId: string,
  ): Promise<OfferSnapshot | null> {
    const snapshot = await this.snapshots.getById(snapshotId);
    if (!snapshot || snapshot.userId !== userId) return null;
    return snapshot;
  }
}
