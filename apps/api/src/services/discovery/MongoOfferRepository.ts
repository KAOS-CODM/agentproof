import type { Product } from '@agentproof/shared';
import type { Db } from 'mongodb';
import { isDuplicateKeyError } from '../../models/mongoErrors.js';
import type { OfferRepository, StoredOffer } from './OfferRepository.js';

/**
 * MongoDB-backed implementation of the shared offer repository.
 *
 * Document contract (`offers`):
 *   { _id: string, source: 'channel3'|'demo_catalog', productId: string,
 *     name, description, price, currency, brand, condition, category,
 *     merchant?, imageUrl?, productUrl?, availability?, externalId?, brandId?,
 *     metadata?, fetchedAt: Date, updatedAt: Date }
 *
 * `_id` is a deterministic encoding of `(source, productId)`, and the
 * `uniq_source_product` unique index enforces the same key at the database
 * level. Product ids are provider-local: the source is always part of the key.
 *
 * `upsert` refreshes only shared offer fields. It never deletes or rewrites
 * `intentDiscoveries`, so refreshing a price cannot erase a prior discovery.
 */

interface OfferDoc {
  _id: string;
  source: Product['source'];
  productId: string;
  name: string;
  description: string;
  price: number;
  currency: string;
  brand: string;
  condition: Product['condition'];
  category: string;
  merchant?: string;
  imageUrl?: string;
  productUrl?: string;
  availability?: NonNullable<Product['availability']>;
  externalId?: string;
  brandId?: string;
  metadata?: Record<string, unknown>;
  fetchedAt: Date;
  updatedAt: Date;
}

/** Optional offer fields that must be removed when a refresh omits them. */
const OPTIONAL_OFFER_FIELDS = [
  'merchant',
  'imageUrl',
  'productUrl',
  'availability',
  'externalId',
  'brandId',
  'metadata',
] as const satisfies readonly (keyof OfferDoc)[];

function offerId(source: Product['source'], productId: string): string {
  // JSON encoding is collision-free for arbitrary string identifiers.
  return JSON.stringify([source, productId]);
}

function toDoc(
  product: Product,
  fetchedAt: Date,
): Omit<OfferDoc, '_id'> {
  const doc: Omit<OfferDoc, '_id'> = {
    source: product.source,
    productId: product.id,
    name: product.name,
    description: product.description,
    price: product.price,
    currency: product.currency,
    brand: product.brand,
    condition: product.condition,
    category: product.category,
    fetchedAt,
    updatedAt: fetchedAt,
  };

  // Optional fields are omitted entirely when absent - never fabricated.
  if (product.merchant !== undefined) doc.merchant = product.merchant;
  if (product.imageUrl !== undefined) doc.imageUrl = product.imageUrl;
  if (product.productUrl !== undefined) doc.productUrl = product.productUrl;
  if (product.availability !== undefined) doc.availability = product.availability;
  if (product.externalId !== undefined) doc.externalId = product.externalId;
  if (product.brandId !== undefined) doc.brandId = product.brandId;
  if (product.metadata !== undefined) doc.metadata = product.metadata;

  return doc;
}

function toProduct(doc: OfferDoc): Product {
  const product: Product = {
    id: doc.productId,
    source: doc.source,
    name: doc.name,
    description: doc.description,
    price: doc.price,
    currency: doc.currency,
    brand: doc.brand,
    condition: doc.condition,
    category: doc.category,
  };

  if (doc.merchant !== undefined) product.merchant = doc.merchant;
  if (doc.imageUrl !== undefined) product.imageUrl = doc.imageUrl;
  if (doc.productUrl !== undefined) product.productUrl = doc.productUrl;
  if (doc.availability !== undefined) product.availability = doc.availability;
  if (doc.externalId !== undefined) product.externalId = doc.externalId;
  if (doc.brandId !== undefined) product.brandId = doc.brandId;
  if (doc.metadata !== undefined) product.metadata = doc.metadata;

  return product;
}

export class MongoOfferRepository implements OfferRepository {
  constructor(private readonly db: Db) {}

  private get collection() {
    return this.db.collection<OfferDoc>('offers');
  }

  async upsert(product: Product, meta: { fetchedAt: string }): Promise<void> {
    const id = offerId(product.source, product.id);
    const fetchedAt = new Date(meta.fetchedAt);
    const doc = toDoc(product, fetchedAt);

    // A refresh replaces the offer snapshot rather than merging into it: an
    // optional field absent from the new snapshot must not retain a stale value
    // from a previous fetch. ($unset is a no-op on the insert path.)
    const unset: Record<string, ''> = {};
    for (const key of OPTIONAL_OFFER_FIELDS) {
      if (doc[key] === undefined) unset[key] = '';
    }

    const update: {
      $set: Omit<OfferDoc, '_id'>;
      $setOnInsert: { _id: string };
      $unset?: Record<string, ''>;
    } = {
      $set: doc,
      $setOnInsert: { _id: id },
    };
    if (Object.keys(unset).length > 0) update.$unset = unset;

    try {
      await this.collection.updateOne({ _id: id }, update, { upsert: true });
    } catch (err) {
      // A concurrent first write can win the insert between our upsert's
      // lookup and insert. Retry once now that the unique document exists; any
      // other error (including a second duplicate) propagates.
      if (!isDuplicateKeyError(err)) throw err;
      await this.collection.updateOne({ _id: id }, update, { upsert: true });
    }
  }

  async get(source: Product['source'], productId: string): Promise<StoredOffer | null> {
    const doc = await this.collection.findOne({ _id: offerId(source, productId) });
    if (!doc) return null;
    return {
      product: toProduct(doc),
      fetchedAt: doc.fetchedAt.toISOString(),
    };
  }
}
