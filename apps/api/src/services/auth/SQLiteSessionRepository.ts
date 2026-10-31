import type {
  PersistedSession,
  Session,
  SessionRepository,
} from './SessionRepository.js';
import { isSessionActive } from './SessionRepository.js';

type SqlJsDatabase = InstanceType<Awaited<ReturnType<typeof import('sql.js')>>['Database']>;

interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

/**
 * sql.js-backed session repository.
 *
 * Only `token_hash` is stored (never the raw bearer token). Expired rows may
 * remain until a future cleanup because SQLite has no TTL; active lookups always
 * re-check expiry in application code.
 */
export class SQLiteSessionRepository implements SessionRepository {
  constructor(private readonly db: SqlJsDatabase) {}

  async create(session: PersistedSession): Promise<void> {
    this.db.run(
      `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        session.id,
        session.userId,
        session.tokenHash,
        session.createdAt,
        session.expiresAt,
        session.revokedAt,
      ],
    );
  }

  async getByTokenHash(tokenHash: string): Promise<Session | null> {
    const stmt = this.db.prepare(
      `SELECT id, user_id, token_hash, created_at, expires_at, revoked_at
       FROM sessions WHERE token_hash = ?`,
    );
    stmt.bind([tokenHash]);
    let row: SessionRow | null = null;
    if (stmt.step()) {
      row = stmt.getAsObject() as unknown as SessionRow;
    }
    stmt.free();
    return row ? rowToSession(row) : null;
  }

  async getActiveByTokenHash(tokenHash: string, now: string): Promise<Session | null> {
    const session = await this.getByTokenHash(tokenHash);
    if (!session || !isSessionActive(session, now)) return null;
    return session;
  }

  async revoke(tokenHash: string, revokedAt: string): Promise<number> {
    this.db.run(
      'UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL',
      [revokedAt, tokenHash],
    );
    return this.db.getRowsModified();
  }

  async revokeAllForUser(userId: string, revokedAt: string): Promise<number> {
    this.db.run(
      'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
      [revokedAt, userId],
    );
    return this.db.getRowsModified();
  }
}
