import type { Db } from 'mongodb';
import { CompositeProductRepository } from './CompositeProductRepository.js';
import { MongoIntentDiscoveryRepository } from './MongoIntentDiscoveryRepository.js';
import { MongoOfferRepository } from './MongoOfferRepository.js';
import { MongoOfferSnapshotRepository } from './MongoOfferSnapshotRepository.js';

/**
 * MongoDB product repository: the shared `offers` collection, immutable
 * `intentOfferSnapshots`, and per-intent `intentDiscoveries`, exposed through
 * the existing `ProductRepository` facade so discovery/resolution callers stay
 * unchanged.
 */
export class MongoProductRepository extends CompositeProductRepository {
  constructor(db: Db) {
    super(
      new MongoOfferRepository(db),
      new MongoOfferSnapshotRepository(db),
      new MongoIntentDiscoveryRepository(db),
    );
  }
}
