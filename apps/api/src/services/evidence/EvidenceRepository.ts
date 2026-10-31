import type { EvidenceRecord } from '@agentproof/shared';

/**
 * Append-only store for evidence records.
 *
 * Every method returns a Promise so the same contract can be satisfied by an
 * asynchronous backend (MongoDB) later. A synchronous SQLite adapter simply
 * returns already-resolved Promises - the Promise type does not make the
 * underlying SQL non-blocking (see SQLiteEvidenceRepository).
 *
 * The interface deliberately exposes no update/delete operation: evidence is
 * append-only, and a lost write must surface as a rejection rather than a
 * silent no-op.
 *
 * P2-C adds recovery-friendly reads/exists to support idempotent retry of
 * post-transition evidence without widening the contract to arbitrary updates.
 */
export type EvidenceAppendOutcome = 'created' | 'exists';

export interface EvidenceRepository {
  /**
   * Append a record. `userId` is the trusted owner supplied by the server; it is
   * never part of the client-facing record. Omitting it creates a legacy/ownerless
   * row that user-scoped reads will not return.
   */
  append(record: EvidenceRecord, userId?: string | null): Promise<void>;
  /**
   * Atomic insert-if-absent used by idempotent/recovery paths.
   *
   * Implementations must rely on their backend's uniqueness constraint (never a
   * read-then-write check) and map a genuine primary-key conflict to `exists`.
   * Unrelated persistence errors must still reject.
   */
  appendIfAbsent(record: EvidenceRecord, userId?: string | null): Promise<EvidenceAppendOutcome>;
  /** Internal/unscoped lookup. Request handlers must use the `ForUser` variants. */
  getById(id: string): Promise<EvidenceRecord | null>;
  /** Load a record only when it is owned by `userId`. */
  getByIdForUser(id: string, userId: string): Promise<EvidenceRecord | null>;
  getByIntentId(intentId: string): Promise<EvidenceRecord[]>;
  getByIntentIdForUser(intentId: string, userId: string): Promise<EvidenceRecord[]>;
  getByTransactionId(transactionId: string): Promise<EvidenceRecord[]>;
  getByTransactionIdForUser(transactionId: string, userId: string): Promise<EvidenceRecord[]>;
  getAll(): Promise<EvidenceRecord[]>;
  /** All records owned by one user, ordered by timestamp ascending. */
  getAllForUser(userId: string): Promise<EvidenceRecord[]>;
  /** Existence check used by recovery/idempotency paths. */
  exists(id: string): Promise<boolean>;
}
