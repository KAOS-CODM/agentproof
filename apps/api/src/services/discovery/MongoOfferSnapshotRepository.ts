import type { Db } from 'mongodb';
import type { OfferSnapshot, OfferSnapshotStore } from './OfferSnapshot.js';

/**
 * MongoDB-backed store for immutable per-intent offer snapshots.
 *
 * Document contract (`intentOfferSnapshots`):
 *   { _id: string, userId: string | null, intentId: string,
 *     source: 'channel3'|'demo_catalog', productId: string,
 *     externalProductId: string | null, productName: string, brand: string,
 *     offerUrl: string | null, merchant: string | null, price: number,
 *     currency: string, availability: string | null, condition: string | null,
 *     compareAtPrice: number | null, maxCommissionRate: number | null,
 *     capturedAt: Date }
 *
 * Documents are insert-only. Re-discovery appends a new snapshot and updates
 * the association in `intentDiscoveries`; it never mutates an existing row.
 */
interface OfferSnapshotDoc {
  _id: string;
  userId: string | null;
  intentId: string;
  source: OfferSnapshot['source'];
  productId: string;
  externalProductId: string | null;
  productName: string;
  brand: string;
  offerUrl: string | null;
  merchant: string | null;
  price: number;
  currency: string;
  availability: OfferSnapshot['availability'];
  condition: OfferSnapshot['condition'];
  compareAtPrice: number | null;
  maxCommissionRate: number | null;
  capturedAt: Date;
}

function toDoc(snapshot: OfferSnapshot): OfferSnapshotDoc {
  return {
    _id: snapshot.id,
    userId: snapshot.userId,
    intentId: snapshot.intentId,
    source: snapshot.source,
    productId: snapshot.productId,
    externalProductId: snapshot.externalProductId,
    productName: snapshot.productName,
    brand: snapshot.brand,
    offerUrl: snapshot.offerUrl,
    merchant: snapshot.merchant,
    price: snapshot.price,
    currency: snapshot.currency,
    availability: snapshot.availability,
    condition: snapshot.condition,
    compareAtPrice: snapshot.compareAtPrice,
    maxCommissionRate: snapshot.maxCommissionRate,
    capturedAt: new Date(snapshot.capturedAt),
  };
}

function toSnapshot(doc: OfferSnapshotDoc): OfferSnapshot {
  return {
    id: doc._id,
    userId: doc.userId,
    intentId: doc.intentId,
    source: doc.source,
    productId: doc.productId,
    externalProductId: doc.externalProductId,
    productName: doc.productName,
    brand: doc.brand,
    offerUrl: doc.offerUrl,
    merchant: doc.merchant,
    price: doc.price,
    currency: doc.currency,
    availability: doc.availability,
    condition: doc.condition,
    compareAtPrice: doc.compareAtPrice,
    maxCommissionRate: doc.maxCommissionRate,
    capturedAt: doc.capturedAt.toISOString(),
  };
}

export class MongoOfferSnapshotRepository implements OfferSnapshotStore {
  constructor(private readonly db: Db) {}

  private get collection() {
    return this.db.collection<OfferSnapshotDoc>('intentOfferSnapshots');
  }

  async create(snapshot: OfferSnapshot): Promise<void> {
    await this.collection.insertOne(toDoc(snapshot));
  }

  async getById(id: string): Promise<OfferSnapshot | null> {
    const doc = await this.collection.findOne({ _id: id });
    return doc ? toSnapshot(doc) : null;
  }
}
