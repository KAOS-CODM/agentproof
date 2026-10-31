import type { Intent, StructuredIntent } from '@agentproof/shared';
import type { IntentRepository, PersistedIntent } from './IntentRepository.js';

interface IntentRow {
  id: string;
  user_id: string | null;
  raw_input: string;
  structured_json: string;
  status: string;
  created_at: string;
  parsed_at: string | null;
  validated_at: string | null;
}

type SqlJsDatabase = InstanceType<Awaited<ReturnType<typeof import('sql.js')>>['Database']>;

/**
 * sql.js-backed implementation of the intent repository.
 *
 * Internally synchronous (sql.js runs in-process); the Promise-based public
 * contract exists so an asynchronous MongoDB adapter can replace it later
 * without changing callers.
 */
export class SQLiteIntentRepository implements IntentRepository {
  constructor(private readonly db: SqlJsDatabase) {}

  async create(intent: PersistedIntent): Promise<void> {
    this.db.run(
      `INSERT INTO intents (id, user_id, raw_input, structured_json, status, created_at, parsed_at, validated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        intent.id,
        intent.userId ?? null,
        intent.rawInput,
        JSON.stringify(intent.structured),
        intent.status,
        intent.createdAt,
        intent.parsedAt,
        intent.validatedAt,
      ],
    );
  }

  async getById(id: string): Promise<Intent | null> {
    const row = this.selectById(id);
    if (!row) return null;
    return {
      id: row.id,
      rawInput: row.raw_input,
      structured: JSON.parse(row.structured_json),
      status: row.status as Intent['status'],
      createdAt: row.created_at,
      parsedAt: row.parsed_at,
      validatedAt: row.validated_at,
    };
  }

  async getByIdForUser(id: string, userId: string): Promise<Intent | null> {
    const row = this.selectByIdForUser(id, userId);
    if (!row) return null;
    return {
      id: row.id,
      rawInput: row.raw_input,
      structured: JSON.parse(row.structured_json),
      status: row.status as Intent['status'],
      createdAt: row.created_at,
      parsedAt: row.parsed_at,
      validatedAt: row.validated_at,
    };
  }

  async listForUser(userId: string, limit: number): Promise<Intent[]> {
    const stmt = this.db.prepare(
      'SELECT * FROM intents WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
    );
    stmt.bind([userId, limit]);
    const intents: Intent[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as unknown as IntentRow;
      intents.push({
        id: row.id,
        rawInput: row.raw_input,
        structured: JSON.parse(row.structured_json),
        status: row.status as Intent['status'],
        createdAt: row.created_at,
        parsedAt: row.parsed_at,
        validatedAt: row.validated_at,
      });
    }
    stmt.free();
    return intents;
  }

  async getStructuredById(id: string): Promise<StructuredIntent | null> {
    const row = this.selectById(id);
    if (!row) return null;
    try {
      return JSON.parse(row.structured_json) as StructuredIntent;
    } catch {
      return null;
    }
  }

  async getStructuredByIdForUser(id: string, userId: string): Promise<StructuredIntent | null> {
    const row = this.selectByIdForUser(id, userId);
    if (!row) return null;
    try {
      return JSON.parse(row.structured_json) as StructuredIntent;
    } catch {
      return null;
    }
  }

  private selectById(id: string): IntentRow | null {
    const stmt = this.db.prepare('SELECT * FROM intents WHERE id = ?');
    stmt.bind([id]);
    let row: IntentRow | null = null;
    if (stmt.step()) {
      row = stmt.getAsObject() as unknown as IntentRow;
    }
    stmt.free();
    return row;
  }

  private selectByIdForUser(id: string, userId: string): IntentRow | null {
    const stmt = this.db.prepare('SELECT * FROM intents WHERE id = ? AND user_id = ?');
    stmt.bind([id, userId]);
    let row: IntentRow | null = null;
    if (stmt.step()) {
      row = stmt.getAsObject() as unknown as IntentRow;
    }
    stmt.free();
    return row;
  }
}
