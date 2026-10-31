import { createHash } from 'node:crypto';
import type { OfferSnapshotView, Product } from '@agentproof/shared';
import type { EvidenceService } from '../evidence/EvidenceService.js';
import { toOfferSnapshotView, isOfferSnapshotFresh, type OfferSnapshot } from './OfferSnapshot.js';
import { DEFAULT_PRODUCT_MAX_AGE_MS } from './ProductResolutionService.js';
import type { ProductRepository } from './ProductRepository.js';
import {
  RETAILER_AFFILIATE_DISCLOSURE,
  RETAILER_HANDOFF_DISCLOSURE_VERSION,
  validateRetailerUrl,
  type RetailerUrlRejection,
} from './RetailerHandoffPolicy.js';

export type RetailerHandoffResult =
  | {
      kind: 'ISSUED';
      url: string;
      disclosure: string;
      offer: OfferSnapshotView;
    }
  | { kind: 'NO_SNAPSHOT' }
  | { kind: 'SNAPSHOT_MISMATCH' }
  | { kind: 'NO_OFFER_URL' }
  | { kind: 'STALE' }
  | { kind: 'INVALID_SNAPSHOT' }
  | { kind: 'UNSAFE_URL'; reason: RetailerUrlRejection };

export interface RetailerHandoffDeps {
  repository: ProductRepository;
  evidence: EvidenceService;
  /** Trusted owner from the authenticated session. */
  userId: string;
  /** Active discovery provider identity, resolved server-side. */
  source: Product['source'];
  allowedTrackingHosts: readonly string[];
  /** Injectable clock for deterministic freshness tests. */
  now?: () => number;
}

function isUsableSnapshot(snapshot: OfferSnapshot): boolean {
  return (
    Number.isFinite(snapshot.price) &&
    snapshot.price > 0 &&
    typeof snapshot.currency === 'string' &&
    snapshot.currency.length === 3 &&
    snapshot.offerUrl !== null
  );
}

function hashUrl(url: string): string {
  return `sha256:${createHash('sha256').update(url, 'utf8').digest('hex')}`;
}

/**
 * Prepares an explicit, owner-scoped retailer handoff from the immutable offer
 * snapshot captured for one intent.
 *
 * It never reads the mutable shared offer, never accepts a URL from the client,
 * and records only the facts the application can establish: that this user
 * requested a handoff for this snapshot and that the URL passed server-side
 * validation. It does not record a purchase or retailer order.
 */
export class RetailerHandoffService {
  constructor(private readonly deps: RetailerHandoffDeps) {}

  async prepare(params: {
    intentId: string;
    productId: string;
    snapshotId: string;
  }): Promise<RetailerHandoffResult> {
    const { repository, evidence, userId, source, allowedTrackingHosts } = this.deps;
    const nowMs = this.deps.now ? this.deps.now() : Date.now();

    // Bind to the exact immutable snapshot the user is looking at. Reading the
    // current intent/product association here would allow a later re-discovery
    // to redirect the handoff to a different price or URL.
    const snapshot = await repository.getSnapshotById(params.snapshotId, userId);
    if (!snapshot) return { kind: 'NO_SNAPSHOT' };
    if (
      snapshot.userId !== userId ||
      snapshot.intentId !== params.intentId ||
      snapshot.source !== source ||
      snapshot.productId !== params.productId
    ) {
      return { kind: 'SNAPSHOT_MISMATCH' };
    }
    if (!snapshot.offerUrl) return { kind: 'NO_OFFER_URL' };
    if (!isUsableSnapshot(snapshot)) return { kind: 'INVALID_SNAPSHOT' };
    if (!Number.isFinite(Date.parse(snapshot.capturedAt))) {
      return { kind: 'INVALID_SNAPSHOT' };
    }
    if (!isOfferSnapshotFresh(snapshot.capturedAt, nowMs, DEFAULT_PRODUCT_MAX_AGE_MS)) {
      return { kind: 'STALE' };
    }

    const validation = validateRetailerUrl(snapshot.offerUrl, {
      merchant: snapshot.merchant,
      allowedTrackingHosts,
    });
    if (!validation.ok) {
      return { kind: 'UNSAFE_URL', reason: validation.reason };
    }

    // A handoff is a user action, not a purchase. Only facts this application
    // can establish are recorded; the full URL is represented by a hash.
    await evidence.record(
      {
        eventType: 'RETAILER_HANDOFF_PREPARED',
        actor: 'user',
        source: source === 'channel3' ? 'channel3' : 'demo_catalog',
        intentId: params.intentId,
        data: {
          snapshotId: snapshot.id,
          productId: snapshot.productId,
          productName: snapshot.productName,
          merchant: snapshot.merchant,
          price: snapshot.price,
          currency: snapshot.currency,
          urlHash: hashUrl(validation.url),
          urlHost: validation.hostname,
          disclosureVersion: RETAILER_HANDOFF_DISCLOSURE_VERSION,
        },
      },
      userId,
    );

    return {
      kind: 'ISSUED',
      url: validation.url,
      disclosure: RETAILER_AFFILIATE_DISCLOSURE,
      offer: toOfferSnapshotView(snapshot),
    };
  }
}
