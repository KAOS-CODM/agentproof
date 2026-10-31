import type { EvidenceRecord } from '@agentproof/shared';
import type { EvidenceRepository } from './EvidenceRepository.js';

interface EvidenceRow {
  id: string;
  user_id?: string | null;
  event_type: string;
  timestamp: string;
  actor: string;
  transaction_id: string | null;
  intent_id: string | null;
  approval_request_id: string | null;
  policy_evaluation_id: string | null;
  data_json: string;
  metadata_json: string;
}

type SqlJsDatabase = InstanceType<Awaited<ReturnType<typeof import('sql.js')>>['Database']>;

function toEvidenceRow(value: unknown): EvidenceRow {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Unexpected sql.js row shape');
  }
  const row = value as Record<string, unknown>;
  const asString = (v: unknown, key: string): string => {
    if (typeof v !== 'string') throw new Error(`Expected string for column ${key}`);
    return v;
  };
  const asStringOrNull = (v: unknown, key: string): string | null => {
    if (v === null) return null;
    return asString(v, key);
  };
  return {
    id: asString(row.id, 'id'),
    event_type: asString(row.event_type, 'event_type'),
    timestamp: asString(row.timestamp, 'timestamp'),
    actor: asString(row.actor, 'actor'),
    transaction_id: asStringOrNull(row.transaction_id, 'transaction_id'),
    intent_id: asStringOrNull(row.intent_id, 'intent_id'),
    approval_request_id: asStringOrNull(row.approval_request_id, 'approval_request_id'),
    policy_evaluation_id: asStringOrNull(row.policy_evaluation_id, 'policy_evaluation_id'),
    data_json: asString(row.data_json, 'data_json'),
    metadata_json: asString(row.metadata_json, 'metadata_json'),
  };
}

function insertValues(record: EvidenceRecord, userId?: string | null): Array<string | null> {
  return [
    record.id,
    userId ?? null,
    record.eventType,
    record.timestamp,
    record.actor,
    record.transactionId,
    record.intentId,
    record.approvalRequestId,
    record.policyEvaluationId,
    JSON.stringify(record.data),
    JSON.stringify(record.metadata),
  ];
}

/**
 * sql.js-backed implementation of the evidence repository.
 *
 * Internally every operation is synchronous (sql.js executes in-process), but
 * the public contract is Promise-based so it is interchangeable with an
 * asynchronous MongoDB implementation later. The Promises resolve with the
 * already-computed value; no work is deferred.
 */
export class SQLiteEvidenceRepository implements EvidenceRepository {
  private db: SqlJsDatabase;

  constructor(db: SqlJsDatabase) {
    this.db = db;
  }

  async append(record: EvidenceRecord, userId?: string | null): Promise<void> {
    this.db.run(
      `INSERT INTO evidence_records (
        id, user_id, event_type, timestamp, actor,
        transaction_id, intent_id, approval_request_id, policy_evaluation_id,
        data_json, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      insertValues(record, userId),
    );
  }

  /**
   * `ON CONFLICT(id) DO NOTHING` scopes idempotency to the primary key only: a
   * duplicate id is a no-op, while unrelated constraint violations still raise.
   * `getRowsModified()` distinguishes the insert from the no-op atomically.
   */
  async appendIfAbsent(
    record: EvidenceRecord,
    userId?: string | null,
  ): Promise<'created' | 'exists'> {
    this.db.run(
      `INSERT INTO evidence_records (
        id, user_id, event_type, timestamp, actor,
        transaction_id, intent_id, approval_request_id, policy_evaluation_id,
        data_json, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING`,
      insertValues(record, userId),
    );
    return this.db.getRowsModified() > 0 ? 'created' : 'exists';
  }

  async getById(id: string): Promise<EvidenceRecord | null> {
    return this.selectOne('id = ?', [id]);
  }

  async getByIdForUser(id: string, userId: string): Promise<EvidenceRecord | null> {
    return this.selectOne('id = ? AND user_id = ?', [id, userId]);
  }

  async getByIntentId(intentId: string): Promise<EvidenceRecord[]> {
    return this.selectMany('intent_id = ?', [intentId]);
  }

  async getByIntentIdForUser(intentId: string, userId: string): Promise<EvidenceRecord[]> {
    return this.selectMany('intent_id = ? AND user_id = ?', [intentId, userId]);
  }

  async getByTransactionId(transactionId: string): Promise<EvidenceRecord[]> {
    return this.selectMany('transaction_id = ?', [transactionId]);
  }

  async getByTransactionIdForUser(
    transactionId: string,
    userId: string,
  ): Promise<EvidenceRecord[]> {
    return this.selectMany('transaction_id = ? AND user_id = ?', [transactionId, userId]);
  }

  async getAll(): Promise<EvidenceRecord[]> {
    return this.selectMany('1 = 1', []);
  }

  async getAllForUser(userId: string): Promise<EvidenceRecord[]> {
    return this.selectMany('user_id = ?', [userId]);
  }

  async exists(id: string): Promise<boolean> {
    const stmt = this.db.prepare('SELECT 1 FROM evidence_records WHERE id = ? LIMIT 1');
    stmt.bind([id]);
    const has = stmt.step();
    stmt.free();
    return has;
  }

  private selectOne(where: string, values: string[]): EvidenceRecord | null {
    const stmt = this.db.prepare(`SELECT * FROM evidence_records WHERE ${where}`);
    stmt.bind(values);
    let row: unknown = null;
    if (stmt.step()) {
      row = stmt.getAsObject();
    }
    stmt.free();
    return row ? this.rowToRecord(toEvidenceRow(row)) : null;
  }

  private selectMany(where: string, values: string[]): EvidenceRecord[] {
    const stmt = this.db.prepare(
      `SELECT * FROM evidence_records WHERE ${where} ORDER BY timestamp ASC`,
    );
    stmt.bind(values);
    const rows: EvidenceRow[] = [];
    while (stmt.step()) {
      rows.push(toEvidenceRow(stmt.getAsObject()));
    }
    stmt.free();
    return rows.map((row) => this.rowToRecord(row));
  }

  private rowToRecord(row: EvidenceRow): EvidenceRecord {
    return {
      id: row.id,
      eventType: row.event_type,
      timestamp: row.timestamp,
      actor: row.actor as EvidenceRecord['actor'],
      transactionId: row.transaction_id,
      intentId: row.intent_id,
      approvalRequestId: row.approval_request_id,
      policyEvaluationId: row.policy_evaluation_id,
      data: JSON.parse(row.data_json),
      metadata: JSON.parse(row.metadata_json),
    };
  }
}
