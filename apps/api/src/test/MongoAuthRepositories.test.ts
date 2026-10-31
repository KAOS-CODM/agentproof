import { describe, it, expect } from 'vitest';
import { MongoUserRepository } from '../services/auth/MongoUserRepository.js';
import { MongoSessionRepository } from '../services/auth/MongoSessionRepository.js';
import { ensureIndexes } from '../models/mongoIndexes.js';
import type { MongoDbLike } from '../models/mongoClient.js';
import { createFakeDb, fakeDocs, DuplicateKeyError } from './fakeMongo.js';

/**
 * P4 MongoDB-adapter behaviour that is not part of the cross-backend contract
 * suite: document shape, BSON Date storage, normalized email, unique-index
 * enforcement, and token/expiry handling. No Atlas connection.
 */

async function setup() {
  const db = createFakeDb();
  await ensureIndexes(db as unknown as MongoDbLike, 'P4');
  return db;
}

const user = {
  id: 'user-1',
  email: '  User@Example.COM ',
  passwordHash: '$2b$fake-password-hash',
  createdAt: '2026-10-20T10:00:00.000Z',
};

const session = {
  id: 'session-1',
  userId: 'user-1',
  tokenHash: 'sha256:deadbeef',
  createdAt: '2026-10-20T10:00:00.000Z',
  expiresAt: '2026-10-20T11:00:00.000Z',
  revokedAt: null,
};

describe('MongoUserRepository', () => {
  it('normalizes email, stores BSON Dates, and never exposes the hash on normal reads', async () => {
    const db = await setup();
    const repo = new MongoUserRepository(db);

    await repo.create(user);

    const [doc] = fakeDocs(db, 'users');
    expect(doc._id).toBe('user-1');
    expect(doc.email).toBe('user@example.com');
    expect(doc.createdAt).toBeInstanceOf(Date);
    expect(doc.passwordHash).toBe('$2b$fake-password-hash');
    expect('password' in doc).toBe(false);

    const publicUser = await repo.getById('user-1');
    expect(publicUser).toEqual({
      id: 'user-1',
      email: 'user@example.com',
      createdAt: '2026-10-20T10:00:00.000Z',
    });
    expect('passwordHash' in publicUser!).toBe(false);
    expect(await repo.getByEmail('USER@example.com')).toEqual(publicUser);

    const credentials = await repo.getCredentialsByEmail('  user@EXAMPLE.com ');
    expect(credentials).toEqual({
      ...publicUser,
      passwordHash: '$2b$fake-password-hash',
    });
  });

  it('rejects a duplicate normalized email through the unique index', async () => {
    const db = await setup();
    const repo = new MongoUserRepository(db);
    await repo.create(user);

    await expect(
      repo.create({ ...user, id: 'user-2', email: 'USER@example.com' }),
    ).rejects.toBeInstanceOf(DuplicateKeyError);

    expect(await repo.getByEmail('user@example.com')).toMatchObject({ id: 'user-1' });
    expect(await repo.getById('user-2')).toBeNull();
  });

  it('propagates an insert failure instead of swallowing it', async () => {
    const db = createFakeDb({ failOn: 'insert' });
    const repo = new MongoUserRepository(db);

    await expect(repo.create(user)).rejects.toThrow('insert failed');
  });
});

describe('MongoSessionRepository', () => {
  it('stores only the token hash and expiry as BSON Dates', async () => {
    const db = await setup();
    const repo = new MongoSessionRepository(db);

    await repo.create(session);

    const [doc] = fakeDocs(db, 'sessions');
    expect(doc._id).toBe('session-1');
    expect(doc.userId).toBe('user-1');
    expect(doc.tokenHash).toBe('sha256:deadbeef');
    expect('token' in doc).toBe(false);
    expect(doc.createdAt).toBeInstanceOf(Date);
    expect(doc.expiresAt).toBeInstanceOf(Date);
    expect(doc.revokedAt).toBeNull();

    expect(await repo.getByTokenHash('sha256:deadbeef')).toEqual(session);
  });

  it('checks expiry and revocation in application code (TTL is asynchronous)', async () => {
    const db = await setup();
    const repo = new MongoSessionRepository(db);
    await repo.create(session);

    expect(
      await repo.getActiveByTokenHash('sha256:deadbeef', '2026-10-20T10:30:00.000Z'),
    ).not.toBeNull();
    expect(
      await repo.getActiveByTokenHash('sha256:deadbeef', '2026-10-20T11:00:00.000Z'),
    ).toBeNull();
    // The document remains until the TTL monitor removes it.
    expect(await repo.getByTokenHash('sha256:deadbeef')).not.toBeNull();

    expect(await repo.revoke('sha256:deadbeef', '2026-10-20T10:15:00.000Z')).toBe(1);
    expect(await repo.revoke('sha256:deadbeef', '2026-10-20T10:20:00.000Z')).toBe(0);

    const [doc] = fakeDocs(db, 'sessions');
    expect(doc.revokedAt).toBeInstanceOf(Date);
    expect((doc.revokedAt as Date).toISOString()).toBe('2026-10-20T10:15:00.000Z');
    expect(
      await repo.getActiveByTokenHash('sha256:deadbeef', '2026-10-20T10:16:00.000Z'),
    ).toBeNull();
  });

  it('revokes all active sessions for one user with updateMany', async () => {
    const db = await setup();
    const repo = new MongoSessionRepository(db);
    await repo.create(session);
    await repo.create({ ...session, id: 'session-2', tokenHash: 'sha256:second' });
    await repo.create({
      ...session,
      id: 'session-3',
      userId: 'user-2',
      tokenHash: 'sha256:other-user',
    });
    await repo.create({
      ...session,
      id: 'session-4',
      tokenHash: 'sha256:already-revoked',
      revokedAt: '2026-10-20T10:05:00.000Z',
    });

    expect(
      await repo.revokeAllForUser('user-1', '2026-10-20T10:30:00.000Z'),
    ).toBe(2);

    expect((await repo.getByTokenHash('sha256:deadbeef'))!.revokedAt).toBe(
      '2026-10-20T10:30:00.000Z',
    );
    expect((await repo.getByTokenHash('sha256:second'))!.revokedAt).toBe(
      '2026-10-20T10:30:00.000Z',
    );
    expect((await repo.getByTokenHash('sha256:other-user'))!.revokedAt).toBeNull();
    expect((await repo.getByTokenHash('sha256:already-revoked'))!.revokedAt).toBe(
      '2026-10-20T10:05:00.000Z',
    );
  });

  it('rejects a duplicate token hash through the unique index', async () => {
    const db = await setup();
    const repo = new MongoSessionRepository(db);
    await repo.create(session);

    await expect(
      repo.create({ ...session, id: 'session-2' }),
    ).rejects.toBeInstanceOf(DuplicateKeyError);

    expect(await repo.getByTokenHash('sha256:deadbeef')).toMatchObject({
      id: 'session-1',
    });
  });
});
