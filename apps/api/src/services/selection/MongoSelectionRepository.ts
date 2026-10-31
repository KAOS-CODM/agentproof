import type { Collection, Db } from 'mongodb';
import { isDuplicateKeyError } from '../../models/mongoErrors.js';
import type {
  PersistedSelection,
  Selection,
  SelectionRepository,
  SelectOutcome,
} from './SelectionRepository.js';
import {
  assertNewSelection,
  assertSelectionRecord,
} from './SelectionRepository.js';

/**
 * MongoDB-backed selection repository.
 *
 * Document contract (`intentSelections`):
 *   { _id: string, userId: string, intentId: string, snapshotId: string,
 *     source: string, productId: string, price: number, currency: string,
 *     isActive: boolean, selectedAt: Date, supersededAt: Date | null }
 *
 * `isActive` is always written, never omitted. The P6 partial unique index is
 * `{ intentId: 1 }` with `partialFilterExpression: { isActive: true }`, so a
 * document without the field would silently fall outside the uniqueness rule
 * and could coexist with another active selection. Storing an explicit boolean
 * is what makes this document shape equivalent to SQLite's
 * `is_active = 1` / `superseded_at IS NULL`.
 *
 * `supersededAt` is written as an explicit `null` on the active row rather than
 * being omitted, mirroring `sessions.revokedAt`: a lifecycle timestamp that is
 * meaningful in both states is easier to audit than an absent key.
 */

interface SelectionDoc {
  _id: string;
  userId: string;
  intentId: string;
  snapshotId: string;
  source: string;
  productId: string;
  price: number;
  currency: string;
  isActive: boolean;
  selectedAt: Date;
  supersededAt: Date | null;
}

function toSelection(doc: SelectionDoc): Selection {
  return {
    id: doc._id,
    userId: doc.userId,
    intentId: doc.intentId,
    snapshotId: doc.snapshotId,
    source: doc.source as Selection['source'],
    productId: doc.productId,
    price: doc.price,
    currency: doc.currency,
    isActive: doc.isActive === true,
    selectedAt: doc.selectedAt.toISOString(),
    supersededAt: doc.supersededAt ? doc.supersededAt.toISOString() : null,
  };
}

export class MongoSelectionRepository implements SelectionRepository {
  constructor(private readonly db: Db) {}

  private get collection(): Collection<SelectionDoc> {
    return this.db.collection<SelectionDoc>('intentSelections');
  }

  private activeFilter(intentId: string, userId: string) {
    return { intentId, userId, isActive: true } as const;
  }

  async select(selection: PersistedSelection): Promise<SelectOutcome> {
    // Validate before the first write. A missing or non-boolean `isActive` must
    // never reach the server as an omitted field.
    assertSelectionRecord(selection);
    assertNewSelection(selection);

    const current = await this.collection.findOne(
      this.activeFilter(selection.intentId, selection.userId),
    );
    if (current && current.snapshotId === selection.snapshotId) {
      return { kind: 'ALREADY_ACTIVE', selection: toSelection(current) };
    }

    // Checked before the supersede so a duplicate id fails without leaving the
    // intent with no active selection as a side effect. This mirrors SQLite and
    // keeps the adapters' observable contracts equivalent; the duplicate-key
    // catch below remains the backstop for a concurrent duplicate-id insert.
    if (await this.collection.findOne({ _id: selection.id })) {
      throw new Error(`Selection ${selection.id} already exists`);
    }

    // Supersede first, insert second: the partial unique index permits exactly
    // one active row per intent, so the new row cannot be inserted while the old
    // one is still active. A crash between the two steps leaves no active
    // selection, which fails closed.
    await this.collection.updateMany(this.activeFilter(selection.intentId, selection.userId), {
      $set: { isActive: false, supersededAt: new Date(selection.selectedAt) },
    });

    try {
      await this.collection.insertOne({
        _id: selection.id,
        userId: selection.userId,
        intentId: selection.intentId,
        snapshotId: selection.snapshotId,
        source: selection.source,
        productId: selection.productId,
        price: selection.price,
        currency: selection.currency,
        isActive: true,
        selectedAt: new Date(selection.selectedAt),
        supersededAt: null,
      });
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;

      // A duplicate _id is a caller bug, not a lost race.
      if (await this.collection.findOne({ _id: selection.id })) throw err;

      const winner = await this.findOneActive(selection.intentId, selection.userId);
      if (!winner) throw err;
      return winner.snapshotId === selection.snapshotId
        ? { kind: 'ALREADY_ACTIVE', selection: winner }
        : { kind: 'CONFLICT', selection: winner };
    }

    return {
      kind: 'ACTIVATED',
      selection: { ...selection, isActive: true, supersededAt: null },
    };
  }

  async getActive(intentId: string, userId: string): Promise<Selection | null> {
    return this.findOneActive(intentId, userId);
  }

  async listHistory(intentId: string, userId: string): Promise<Selection[]> {
    const docs = await this.collection
      .find({ intentId, userId })
      .sort({ selectedAt: -1, _id: -1 })
      .toArray();
    return docs.map(toSelection);
  }

  private async findOneActive(intentId: string, userId: string): Promise<Selection | null> {
    const doc = await this.collection.findOne(this.activeFilter(intentId, userId));
    return doc ? toSelection(doc) : null;
  }
}
