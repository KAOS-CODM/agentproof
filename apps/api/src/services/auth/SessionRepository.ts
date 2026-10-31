/**
 * A server-side session. Only a hash of the bearer token is persisted; the raw
 * token is never stored.
 *
 * `expiresAt` is an ISO timestamp in the persistence contract and a BSON `Date`
 * in MongoDB. Expiry is always re-checked by the application because MongoDB TTL
 * deletion is asynchronous.
 */
export interface Session {
  id: string;
  userId: string;
  /** One-way hash of the bearer token; never the raw token. */
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  /** ISO timestamp of first revocation, or null while the session is active. */
  revokedAt: string | null;
}

/** Input for creating a session. */
export type PersistedSession = Session;

/**
 * True only while the session is unrevoked and strictly before `expiresAt`.
 * Malformed timestamps fail closed (treated as inactive).
 */
export function isSessionActive(session: Session, now: string): boolean {
  if (session.revokedAt !== null) return false;
  const expiresAt = Date.parse(session.expiresAt);
  const current = Date.parse(now);
  if (Number.isNaN(expiresAt) || Number.isNaN(current)) return false;
  return current < expiresAt;
}

/**
 * Server-side session store used by authentication. Revocation is idempotent:
 * only the first revocation timestamp is kept.
 */
export interface SessionRepository {
  /** Persist a new session. A duplicate id or token hash is rejected. */
  create(session: PersistedSession): Promise<void>;

  /**
   * Load a session by token hash regardless of state. Useful for diagnostics;
   * authentication must use `getActiveByTokenHash`.
   */
  getByTokenHash(tokenHash: string): Promise<Session | null>;

  /**
   * Load a session only when it is unrevoked and not expired at `now`.
   * Application-level expiry checking is required even with a MongoDB TTL index.
   */
  getActiveByTokenHash(tokenHash: string, now: string): Promise<Session | null>;

  /**
   * Revoke the session with this token hash. Returns the number of sessions
   * transitioned (0 when unknown or already revoked).
   */
  revoke(tokenHash: string, revokedAt: string): Promise<number>;

  /**
   * Revoke every currently active session for a user ("log out everywhere").
   * Returns the number transitioned; already-revoked sessions keep their
   * original timestamp.
   */
  revokeAllForUser(userId: string, revokedAt: string): Promise<number>;
}
