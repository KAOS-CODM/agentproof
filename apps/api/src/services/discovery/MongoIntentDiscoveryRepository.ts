import type { Product } from '@agentproof/shared';
import type { Db } from 'mongodb';
import { isDuplicateKeyError } from '../../models/mongoErrors.js';
import type {
  DiscoveryDecision,
  IntentDiscovery,
  IntentDiscoveryRepository,
} from './IntentDiscoveryRepository.js';

/**
 * MongoDB-backed implementation of per-intent discovery associations.
 *
 * Document contract (`intentDiscoveries`):
 *   { _id: string, intentId: string, source: 'channel3'|'demo_catalog',
 *     productId: string, discoveredAt: Date, evaluationId: string | null,
 *     decision: 'ALLOW'|'DENY' | null, confirmationRequired: boolean | null }
 *
 * There is no `userId`: the current contract has no authentication or
 * ownership, so none is invented here.
 *
 * `_id` is a deterministic encoding of `(intentId, source, productId)` and the
 * `uniq_intent_provider_product` unique index enforces the same association key
 * at the database level. Because the key includes the intent id, the same
 * provider product discovered by two different intents creates two independent
 * documents instead of overwriting one another.
 */

interface IntentDiscoveryDoc {
  _id: string;
  intentId: string;
  source: Product['source'];
  productId: string;
  discoveredAt: Date;
  evaluationId: string | null;
  decision: DiscoveryDecision | null;
  confirmationRequired: boolean | null;
  snapshotId: string | null;
}

function discoveryId(
  intentId: string,
  source: Product['source'],
  productId: string,
): string {
  // JSON encoding is collision-free for arbitrary string identifiers.
  return JSON.stringify([intentId, source, productId]);
}

function toDoc(discovery: IntentDiscovery): IntentDiscoveryDoc {
  return {
    _id: discoveryId(discovery.intentId, discovery.source, discovery.productId),
    intentId: discovery.intentId,
    source: discovery.source,
    productId: discovery.productId,
    discoveredAt: new Date(discovery.discoveredAt),
    evaluationId: discovery.evaluationId,
    decision: discovery.decision,
    confirmationRequired: discovery.confirmationRequired,
    snapshotId: discovery.snapshotId ?? null,
  };
}

function toDiscovery(doc: IntentDiscoveryDoc): IntentDiscovery {
  return {
    intentId: doc.intentId,
    source: doc.source,
    productId: doc.productId,
    discoveredAt: doc.discoveredAt.toISOString(),
    evaluationId: doc.evaluationId,
    decision: doc.decision,
    confirmationRequired: doc.confirmationRequired,
    snapshotId: doc.snapshotId ?? null,
  };
}

export class MongoIntentDiscoveryRepository implements IntentDiscoveryRepository {
  constructor(private readonly db: Db) {}

  private get collection() {
    return this.db.collection<IntentDiscoveryDoc>('intentDiscoveries');
  }

  async upsert(discovery: IntentDiscovery): Promise<void> {
    const doc = toDoc(discovery);
    const update = {
      $set: {
        intentId: doc.intentId,
        source: doc.source,
        productId: doc.productId,
        discoveredAt: doc.discoveredAt,
        evaluationId: doc.evaluationId,
        decision: doc.decision,
        confirmationRequired: doc.confirmationRequired,
        snapshotId: doc.snapshotId,
      },
      $setOnInsert: { _id: doc._id },
    };

    try {
      await this.collection.updateOne({ _id: doc._id }, update, { upsert: true });
    } catch (err) {
      // Concurrent first writes of the same association can collide on the
      // unique key. Retry once (the winner's document now exists); unrelated
      // database errors are never swallowed.
      if (!isDuplicateKeyError(err)) throw err;
      await this.collection.updateOne({ _id: doc._id }, update, { upsert: true });
    }
  }

  async get(
    intentId: string,
    source: Product['source'],
    productId: string,
  ): Promise<IntentDiscovery | null> {
    const doc = await this.collection.findOne({
      _id: discoveryId(intentId, source, productId),
    });
    return doc ? toDiscovery(doc) : null;
  }

  async listByIntent(intentId: string): Promise<IntentDiscovery[]> {
    const docs = await this.collection
      .find({ intentId })
      .sort({ discoveredAt: -1 })
      .toArray();
    return docs.map(toDiscovery);
  }
}
