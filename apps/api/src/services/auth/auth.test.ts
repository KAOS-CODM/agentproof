import { describe, it, expect, beforeEach } from 'vitest';
import {
  AuthService,
  type AuthServiceDeps,
} from './AuthService.js';
import {
  hashPassword,
  verifyPassword,
  verifyPasswordWithDummyOnUnknown,
} from './passwordHasher.js';
import {
  SESSION_COOKIE_NAME,
  buildSessionCookieOptions,
  createSessionToken,
  hashSessionToken,
  readSessionTokenFromCookieHeader,
} from './sessionToken.js';
import {
  InMemorySessionRepository,
  InMemoryUserRepository,
} from '../../test/inMemoryRepositories.js';
import type { UserRepository } from './UserRepository.js';

const PASSWORD = 'correct horse battery staple';
const USER_ID = 'user-1';
const EMAIL = 'user@example.com';

function deps(overrides: Partial<AuthServiceDeps> = {}): AuthServiceDeps {
  return {
    users: new InMemoryUserRepository(),
    sessions: new InMemorySessionRepository(),
    sessionTtlMs: 60 * 60 * 1000,
    tokenFactory: () => 'fixed-session-token',
    ...overrides,
  };
}

async function seedUser(users: UserRepository): Promise<void> {
  await users.create({
    id: USER_ID,
    email: EMAIL,
    passwordHash: await hashPassword(PASSWORD),
    createdAt: '2026-10-20T10:00:00.000Z',
  });
}

describe('password hashing', () => {
  it('stores a salted scrypt hash and verifies only the correct password', async () => {
    const hash = await hashPassword(PASSWORD);

    expect(hash).not.toContain(PASSWORD);
    expect(hash.startsWith('scrypt$1$')).toBe(true);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyPassword('wrong password', hash)).toBe(false);
  });

  it('uses a fresh salt for every hash', async () => {
    const first = await hashPassword(PASSWORD);
    const second = await hashPassword(PASSWORD);

    expect(first).not.toBe(second);
    expect(await verifyPassword(PASSWORD, first)).toBe(true);
    expect(await verifyPassword(PASSWORD, second)).toBe(true);
  });

  it('fails closed for malformed or unsupported hashes', async () => {
    expect(await verifyPassword(PASSWORD, '')).toBe(false);
    expect(await verifyPassword(PASSWORD, 'plaintext')).toBe(false);
    expect(await verifyPassword(PASSWORD, 'scrypt$2$1$1$1$c2FsdA==$aGFzaA==')).toBe(false);
    expect(await verifyPasswordWithDummyOnUnknown(PASSWORD, 'not-a-hash')).toBe(false);
  });

  it('rejects an empty password instead of hashing it', async () => {
    await expect(hashPassword('')).rejects.toThrow('Password must not be empty');
  });
});

describe('session tokens', () => {
  it('creates an unpredictable 32-byte token and stores only its hash', () => {
    const first = createSessionToken();
    const second = createSessionToken();

    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(43);
    expect(hashSessionToken(first)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(first)).toBe(hashSessionToken(first));
    expect(hashSessionToken(first)).not.toContain(first);
  });

  it('reads only the named session cookie', () => {
    expect(
      readSessionTokenFromCookieHeader(`other=1; ${SESSION_COOKIE_NAME}=abc123; more=2`),
    ).toBe('abc123');
    expect(readSessionTokenFromCookieHeader('other=1')).toBeNull();
    expect(readSessionTokenFromCookieHeader(undefined)).toBeNull();
    expect(readSessionTokenFromCookieHeader(`${SESSION_COOKIE_NAME}=`)).toBeNull();
  });

  it('builds an HttpOnly, SameSite=Strict cookie that expires with the session', () => {
    const options = buildSessionCookieOptions({
      secure: true,
      maxAgeMs: 3_600_000,
      expiresAt: '2026-10-20T11:00:00.000Z',
    });

    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe('strict');
    expect(options.secure).toBe(true);
    expect(options.path).toBe('/');
    expect(options.maxAge).toBe(3_600_000);
    expect(options.expires?.toISOString()).toBe('2026-10-20T11:00:00.000Z');
    expect(
      buildSessionCookieOptions({
        secure: false,
        maxAgeMs: 1000,
        expiresAt: '2026-10-20T10:00:01.000Z',
      }).secure,
    ).toBe(false);
  });
});

describe('AuthService', () => {
  let users: InMemoryUserRepository;
  let sessions: InMemorySessionRepository;
  let service: AuthService;
  let now: Date;

  beforeEach(async () => {
    users = new InMemoryUserRepository();
    sessions = new InMemorySessionRepository();
    await seedUser(users);
    now = new Date('2026-10-20T10:00:00.000Z');
    service = new AuthService({
      users,
      sessions,
      sessionTtlMs: 60 * 60 * 1000,
      now: () => now,
    });
  });

  it('logs in with normalized email and issues a session containing only a token hash', async () => {
    const result = await service.login('  USER@Example.com ', PASSWORD);

    expect(result).not.toBeNull();
    expect(result!.user).toEqual({ id: USER_ID, email: EMAIL });
    expect(result!.expiresAt).toBe('2026-10-20T11:00:00.000Z');
    expect(result!.token).toBeTruthy();

    const stored = await sessions.getByTokenHash(hashSessionToken(result!.token));
    expect(stored).not.toBeNull();
    expect(stored!.userId).toBe(USER_ID);
    expect(stored!.tokenHash).not.toBe(result!.token);
  });

  it('returns a generic null for a wrong password or unknown account', async () => {
    expect(await service.login(EMAIL, 'wrong password')).toBeNull();
    expect(await service.login('nobody@example.com', PASSWORD)).toBeNull();
    expect(await service.login(EMAIL, '')).toBeNull();
  });

  it('does not leak persistence failures as successful logins', async () => {
    const brokenUsers: UserRepository = {
      async create() {},
      async getById() {
        return null;
      },
      async getByEmail() {
        return null;
      },
      async getCredentialsByEmail() {
        throw new Error('database unavailable');
      },
    };
    const broken = new AuthService({
      users: brokenUsers,
      sessions,
      sessionTtlMs: 60 * 60 * 1000,
    });

    await expect(broken.login(EMAIL, PASSWORD)).resolves.toBeNull();
  });

  it('authenticates an active session and rejects it after the TTL', async () => {
    const result = await service.login(EMAIL, PASSWORD);
    expect(await service.authenticate(result!.token)).toMatchObject({
      user: { id: USER_ID, email: EMAIL },
    });

    now = new Date('2026-10-20T10:59:59.999Z');
    expect(await service.authenticate(result!.token)).not.toBeNull();

    now = new Date('2026-10-20T11:00:00.000Z');
    expect(await service.authenticate(result!.token)).toBeNull();
  });

  it('revokes the session on logout and remains idempotent', async () => {
    const result = await service.login(EMAIL, PASSWORD);
    expect(await service.authenticate(result!.token)).not.toBeNull();

    await service.logout(result!.token);
    expect(await service.authenticate(result!.token)).toBeNull();

    const stored = await sessions.getByTokenHash(hashSessionToken(result!.token));
    expect(stored!.revokedAt).toBe('2026-10-20T10:00:00.000Z');
    await service.logout(result!.token);
    expect(
      (await sessions.getByTokenHash(hashSessionToken(result!.token)))!.revokedAt,
    ).toBe('2026-10-20T10:00:00.000Z');
  });

  it('rejects unknown or malformed session tokens', async () => {
    expect(await service.authenticate('')).toBeNull();
    expect(await service.authenticate('not-a-real-token')).toBeNull();
  });

  it('provisions an initial user with a hashed password and normalized email', async () => {
    const freshUsers = new InMemoryUserRepository();
    const fresh = new AuthService({
      users: freshUsers,
      sessions,
      sessionTtlMs: 60 * 60 * 1000,
      now: () => now,
    });

    const created = await fresh.provisionInitialUser(' Admin@Example.COM ', PASSWORD);
    expect(created.created).toBe(true);

    const stored = await freshUsers.getCredentialsByEmail('admin@example.com');
    expect(stored).not.toBeNull();
    expect(stored!.email).toBe('admin@example.com');
    expect(stored!.passwordHash).not.toContain(PASSWORD);
    expect(await verifyPassword(PASSWORD, stored!.passwordHash)).toBe(true);

    const again = await fresh.provisionInitialUser('admin@example.com', PASSWORD);
    expect(again).toEqual({ created: false, userId: created.userId });
  });

  it('refuses to provision an initial user with a weak password', async () => {
    await expect(service.provisionInitialUser('admin@example.com', 'short')).rejects.toThrow(
      'at least 12 characters',
    );
    expect(await users.getByEmail('admin@example.com')).toBeNull();
  });
});
