import type { EvidenceRecord } from '@agentproof/shared';
import type { EvidenceRepository } from './EvidenceRepository.js';

interface EvidenceRow {
  id: string;
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

export class SQLiteEvidenceRepository implements EvidenceRepository {
  private db: SqlJsDatabase;

  constructor(db: SqlJsDatabase) {
    this.db = db;
  }

  append(record: EvidenceRecord): void {
    this.db.run(
      `INSERT INTO evidence_records (
        id, event_type, timestamp, actor,
        transaction_id, intent_id, approval_request_id, policy_evaluation_id,
        data_json, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.eventType,
        record.timestamp,
        record.actor,
        record.transactionId,
        record.intentId,
        record.approvalRequestId,
        record.policyEvaluationId,
        JSON.stringify(record.data),
        JSON.stringify(record.metadata),
      ],
    );
  }

  getById(id: string): EvidenceRecord | null {
    const stmt = this.db.prepare('SELECT * FROM evidence_records WHERE id = ?');
    stmt.bind([id]);
    let row: unknown = null;
    if (stmt.step()) {
      row = stmt.getAsObject();
    }
    stmt.free();
    return row ? this.rowToRecord(toEvidenceRow(row)) : null;
  }

  getByIntentId(intentId: string): EvidenceRecord[] {
    const stmt = this.db.prepare(
      'SELECT * FROM evidence_records WHERE intent_id = ? ORDER BY timestamp ASC',
    );
    stmt.bind([intentId]);
    const rows: EvidenceRow[] = [];
    while (stmt.step()) {
      rows.push(toEvidenceRow(stmt.getAsObject()));
    }
    stmt.free();
    return rows.map((r) => this.rowToRecord(r));
  }

  getByTransactionId(transactionId: string): EvidenceRecord[] {
    const stmt = this.db.prepare(
      'SELECT * FROM evidence_records WHERE transaction_id = ? ORDER BY timestamp ASC',
    );
    stmt.bind([transactionId]);
    const rows: EvidenceRow[] = [];
    while (stmt.step()) {
      rows.push(toEvidenceRow(stmt.getAsObject()));
    }
    stmt.free();
    return rows.map((r) => this.rowToRecord(r));
  }

  getAll(): EvidenceRecord[] {
    const stmt = this.db.prepare(
      'SELECT * FROM evidence_records ORDER BY timestamp ASC',
    );
    const rows: EvidenceRow[] = [];
    while (stmt.step()) {
      rows.push(toEvidenceRow(stmt.getAsObject()));
    }
    stmt.free();
    return rows.map((r) => this.rowToRecord(r));
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
