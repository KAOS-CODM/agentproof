import type { Collection, Db } from 'mongodb';
import type {
  PersistedSession,
  Session,
  SessionRepository,
} from './SessionRepository.js';
import { isSessionActive } from './SessionRepository.js';

/**
 * MongoDB-backed session repository.
 *
 * Document contract (`sessions`):
 *   { _id: string, userId: string, tokenHash: string, createdAt: Date,
 *     expiresAt: Date, revokedAt: Date | null }
 *
 * `expiresAt` is always a BSON `Date` so the P4 TTL index can remove expired
 * documents. TTL deletion is asynchronous, so every active lookup still checks
 * expiry (and revocation) in application code.
 *
 * Only the token hash is stored. The raw bearer token never reaches this layer.
 */

interface SessionDoc {
  _id: string;
  userId: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

function toSession(doc: SessionDoc): Session {
  return {
    id: doc._id,
    userId: doc.userId,
    tokenHash: doc.tokenHash,
    createdAt: doc.createdAt.toISOString(),
    expiresAt: doc.expiresAt.toISOString(),
    revokedAt: doc.revokedAt ? doc.revokedAt.toISOString() : null,
  };
}

export class MongoSessionRepository implements SessionRepository {
  constructor(private readonly db: Db) {}

  private get collection(): Collection<SessionDoc> {
    return this.db.collection<SessionDoc>('sessions');
  }

  async create(session: PersistedSession): Promise<void> {
    // Unconditional insert: the unique _id/tokenHash indexes reject duplicates
    // rather than silently replacing an issued session.
    await this.collection.insertOne({
      _id: session.id,
      userId: session.userId,
      tokenHash: session.tokenHash,
      createdAt: new Date(session.createdAt),
      expiresAt: new Date(session.expiresAt),
      revokedAt: session.revokedAt === null ? null : new Date(session.revokedAt),
    });
  }

  async getByTokenHash(tokenHash: string): Promise<Session | null> {
    const doc = await this.collection.findOne({ tokenHash });
    return doc ? toSession(doc) : null;
  }

  async getActiveByTokenHash(tokenHash: string, now: string): Promise<Session | null> {
    const session = await this.getByTokenHash(tokenHash);
    if (!session || !isSessionActive(session, now)) return null;
    return session;
  }

  async revoke(tokenHash: string, revokedAt: string): Promise<number> {
    const result = await this.collection.updateOne(
      { tokenHash, revokedAt: null },
      { $set: { revokedAt: new Date(revokedAt) } },
    );
    return result.matchedCount;
  }

  async revokeAllForUser(userId: string, revokedAt: string): Promise<number> {
    const result = await this.collection.updateMany(
      { userId, revokedAt: null },
      { $set: { revokedAt: new Date(revokedAt) } },
    );
    return result.matchedCount;
  }
}
