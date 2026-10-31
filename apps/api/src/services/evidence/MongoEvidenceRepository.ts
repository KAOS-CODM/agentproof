import type { EvidenceRecord } from '@agentproof/shared';
import type { Db } from 'mongodb';
import type { EvidenceRepository } from './EvidenceRepository.js';

/**
 * MongoDB-backed implementation of the evidence repository.
 *
 * Document contract (`evidenceRecords`):
 *   { _id: string, eventType: string, timestamp: Date, actor: string,
 *     transactionId: string | null, intentId: string | null,
 *     approvalRequestId: string | null, policyEvaluationId: string | null,
 *     data: object, metadata: { source, correlationId } }
 *
 * Append-only: there is no update/delete path, so a lost write surfaces as a
 * rejection. `timestamp` is stored as a BSON `Date` and returned as the ISO
 * string the domain type uses; the nullable correlation fields are stored and
 * returned as `null` consistently with the SQLite adapter.
 *
 * Ordering: every read returns records ordered by `timestamp` ascending, exactly
 * like `SQLiteEvidenceRepository` (which orders with `ORDER BY timestamp ASC`).
 * The declared `by_intent`/`by_transaction`/`by_timestamp` indexes back these
 * sorts so they are index-ordered rather than in-memory.
 *
 * Ownership (P5): `userId` is written only from the trusted server-side owner
 * supplied by the service layer. Request handlers use the `ForUser` reads, so
 * legacy documents without `userId` remain in the ledger but are never returned
 * to an ordinary user. `getAll()` is retained for internal/contract use only.
 */

interface EvidenceDoc {
  _id: string;
  userId?: string;
  eventType: string;
  timestamp: Date;
  actor: EvidenceRecord['actor'];
  transactionId: string | null;
  intentId: string | null;
  approvalRequestId: string | null;
  policyEvaluationId: string | null;
  data: Record<string, unknown>;
  metadata: { source: string; correlationId: string };
}

function toRecord(doc: EvidenceDoc): EvidenceRecord {
  return {
    id: doc._id,
    eventType: doc.eventType,
    timestamp: doc.timestamp.toISOString(),
    actor: doc.actor,
    transactionId: doc.transactionId,
    intentId: doc.intentId,
    approvalRequestId: doc.approvalRequestId,
    policyEvaluationId: doc.policyEvaluationId,
    data: doc.data,
    metadata: doc.metadata,
  };
}

function toDoc(record: EvidenceRecord, userId?: string | null): EvidenceDoc {
  const doc: EvidenceDoc = {
    _id: record.id,
    eventType: record.eventType,
    timestamp: new Date(record.timestamp),
    actor: record.actor,
    transactionId: record.transactionId,
    intentId: record.intentId,
    approvalRequestId: record.approvalRequestId,
    policyEvaluationId: record.policyEvaluationId,
    data: record.data,
    metadata: record.metadata,
  };
  if (userId) doc.userId = userId;
  return doc;
}

function isDuplicateKeyError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; writeErrors?: unknown[] };
  // 11000 is MongoDB's duplicate-key error code. Error *messages* are not
  // inspected: an unrelated failure whose text mentions "duplicate" must not be
  // silently reclassified as an idempotent success.
  if (e.code === 11000) return true;
  return (
    Array.isArray(e.writeErrors) &&
    e.writeErrors.some((w) => (w as { code?: unknown } | null)?.code === 11000)
  );
}

export class MongoEvidenceRepository implements EvidenceRepository {
  constructor(private readonly db: Db) {}

  private get collection() {
    return this.db.collection<EvidenceDoc>('evidenceRecords');
  }

  async append(record: EvidenceRecord, userId?: string | null): Promise<void> {
    await this.collection.insertOne(toDoc(record, userId));
  }

  async appendIfAbsent(
    record: EvidenceRecord,
    userId?: string | null,
  ): Promise<'created' | 'exists'> {
    try {
      await this.collection.insertOne(toDoc(record, userId));
      return 'created';
    } catch (err) {
      // Mongo duplicate key: only _id conflicts are idempotent here. Any
      // unrelated error must still propagate.
      if (isDuplicateKeyError(err)) {
        return 'exists';
      }
      throw err;
    }
  }

  async getById(id: string): Promise<EvidenceRecord | null> {
    const doc = await this.collection.findOne({ _id: id });
    return doc ? toRecord(doc) : null;
  }

  async getByIdForUser(id: string, userId: string): Promise<EvidenceRecord | null> {
    const doc = await this.collection.findOne({ _id: id, userId });
    return doc ? toRecord(doc) : null;
  }

  async getByIntentId(intentId: string): Promise<EvidenceRecord[]> {
    return this.findMany({ intentId });
  }

  async getByIntentIdForUser(intentId: string, userId: string): Promise<EvidenceRecord[]> {
    return this.findMany({ intentId, userId });
  }

  async getByTransactionId(transactionId: string): Promise<EvidenceRecord[]> {
    return this.findMany({ transactionId });
  }

  async getByTransactionIdForUser(
    transactionId: string,
    userId: string,
  ): Promise<EvidenceRecord[]> {
    return this.findMany({ transactionId, userId });
  }

  async getAll(): Promise<EvidenceRecord[]> {
    return this.findMany({});
  }

  async getAllForUser(userId: string): Promise<EvidenceRecord[]> {
    return this.findMany({ userId });
  }

  private async findMany(filter: Record<string, unknown>): Promise<EvidenceRecord[]> {
    const docs = await this.collection
      .find(filter as never)
      .sort({ timestamp: 1 })
      .toArray();
    return docs.map(toRecord);
  }

  async exists(id: string): Promise<boolean> {
    const doc = await this.collection.findOne({ _id: id }, { projection: { _id: 1 } });
    return doc !== null;
  }
}
