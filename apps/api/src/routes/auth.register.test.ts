import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { authRouter } from './auth.js';
import { setRepositoryOverrides } from '../models/repositories.js';
import {
  InMemoryUserRepository,
  InMemorySessionRepository,
  seedTestUser,
} from '../test/inMemoryRepositories.js';
import { verifyPassword } from '../services/auth/passwordHasher.js';

const STRONG_PASSWORD = 'correct horse battery staple';

let server: Server;
let baseUrl: string;
let userRepo: InMemoryUserRepository;
let sessionRepo: InMemorySessionRepository;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', authRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  setRepositoryOverrides({});
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  userRepo = new InMemoryUserRepository();
  sessionRepo = new InMemorySessionRepository();
  setRepositoryOverrides({ user: userRepo, session: sessionRepo });
});

afterEach(() => {
  setRepositoryOverrides({});
});

async function postJson(path: string, body: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function getJson(path: string, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  return fetch(`${baseUrl}${path}`, { headers });
}

function cookieFrom(res: Response): string {
  const setCookie = res.headers.get('set-cookie');
  expect(setCookie).toBeTruthy();
  return setCookie!.split(';')[0];
}

describe('POST /api/v1/auth/register', () => {
  it('creates a user, hashes the password, and starts a session', async () => {
    const res = await postJson('/api/v1/auth/register', {
      email: 'alice@example.com',
      password: STRONG_PASSWORD,
    });

    expect(res.status).toBe(201);
    const body = await res.json() as {
      user: { id: string; email: string };
      expiresAt: string;
    };
    expect(body.user.email).toBe('alice@example.com');
    expect(body.user.id).toBeTruthy();
    expect(body.expiresAt).toBeTruthy();

    // The response must never expose the password, its hash, or the session token.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('scrypt$');
    expect(serialized).not.toContain('token');

    // The registration decision is to auto-login with a normal session cookie.
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
    const cookie = cookieFrom(res);
    const sessionRes = await getJson('/api/v1/auth/session', cookie);
    expect(sessionRes.status).toBe(200);
    const sessionBody = await sessionRes.json() as { user: { id: string; email: string } };
    expect(sessionBody.user.id).toBe(body.user.id);
    expect(sessionBody.user.email).toBe('alice@example.com');

    // The stored credential must be a scrypt hash, not plaintext.
    const credentials = await userRepo.getCredentialsByEmail('alice@example.com');
    expect(credentials).not.toBeNull();
    expect(credentials!.passwordHash).not.toBe(STRONG_PASSWORD);
    expect(credentials!.passwordHash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword(STRONG_PASSWORD, credentials!.passwordHash)).toBe(true);
  });

  it('rejects duplicate email addresses, including case variants', async () => {
    const first = await postJson('/api/v1/auth/register', {
      email: 'Bob@Example.com',
      password: STRONG_PASSWORD,
    });
    expect(first.status).toBe(201);

    const second = await postJson('/api/v1/auth/register', {
      email: 'bob@example.com',
      password: 'another correct horse battery staple',
    });
    expect(second.status).toBe(409);
    const body = await second.json() as { error: string };
    expect(body.error).toBe('Email already registered');
  });

  it('rejects invalid email addresses', async () => {
    const res = await postJson('/api/v1/auth/register', {
      email: 'not-an-email',
      password: STRONG_PASSWORD,
    });
    expect(res.status).toBe(400);
  });

  it('rejects passwords shorter than 12 characters', async () => {
    const res = await postJson('/api/v1/auth/register', {
      email: 'weak@example.com',
      password: 'short',
    });
    expect(res.status).toBe(400);
  });

  it('allows the newly registered user to log in with the same credentials', async () => {
    const reg = await postJson('/api/v1/auth/register', {
      email: 'carol@example.com',
      password: STRONG_PASSWORD,
    });
    expect(reg.status).toBe(201);

    const login = await postJson('/api/v1/auth/login', {
      email: 'carol@example.com',
      password: STRONG_PASSWORD,
    });
    expect(login.status).toBe(200);
    const body = await login.json() as { user: { email: string } };
    expect(body.user.email).toBe('carol@example.com');
  });

  it('creates independent identities and sessions for two users', async () => {
    const aRes = await postJson('/api/v1/auth/register', {
      email: 'usera@example.com',
      password: STRONG_PASSWORD,
    });
    const bRes = await postJson('/api/v1/auth/register', {
      email: 'userb@example.com',
      password: 'another correct horse battery staple',
    });
    expect(aRes.status).toBe(201);
    expect(bRes.status).toBe(201);

    const aBody = await aRes.json() as { user: { id: string; email: string } };
    const bBody = await bRes.json() as { user: { id: string; email: string } };
    expect(aBody.user.id).not.toBe(bBody.user.id);
    expect(aBody.user.email).not.toBe(bBody.user.email);

    const aCookie = cookieFrom(aRes);
    const bCookie = cookieFrom(bRes);
    expect(aCookie).not.toBe(bCookie);

    const aSession = await getJson('/api/v1/auth/session', aCookie);
    const bSession = await getJson('/api/v1/auth/session', bCookie);
    expect(aSession.status).toBe(200);
    expect(bSession.status).toBe(200);
    const aSessionBody = await aSession.json() as { user: { id: string } };
    const bSessionBody = await bSession.json() as { user: { id: string } };
    expect(aSessionBody.user.id).toBe(aBody.user.id);
    expect(bSessionBody.user.id).toBe(bBody.user.id);
    expect(aSessionBody.user.id).not.toBe(bSessionBody.user.id);

    // Logging out User A must not revoke User B's session.
    const logoutA = await postJson('/api/v1/auth/logout', {}, aCookie);
    expect(logoutA.status).toBe(204);
    const aAfter = await getJson('/api/v1/auth/session', aCookie);
    expect(aAfter.status).toBe(401);
    const bAfter = await getJson('/api/v1/auth/session', bCookie);
    expect(bAfter.status).toBe(200);
    const bAfterBody = await bAfter.json() as { user: { id: string } };
    expect(bAfterBody.user.id).toBe(bBody.user.id);
  });

  it('seedTestUser creates distinct, usable users through the test infrastructure', async () => {
    const userA = await seedTestUser(userRepo, 'seed-a@example.com', STRONG_PASSWORD);
    const userB = await seedTestUser(userRepo, 'seed-b@example.com', STRONG_PASSWORD);

    expect(userA.id).toBeTruthy();
    expect(userB.id).toBeTruthy();
    expect(userA.id).not.toBe(userB.id);
    expect(userA.email).not.toBe(userB.email);

    const loginA = await postJson('/api/v1/auth/login', {
      email: userA.email,
      password: userA.password,
    });
    const loginB = await postJson('/api/v1/auth/login', {
      email: userB.email,
      password: userB.password,
    });
    expect(loginA.status).toBe(200);
    expect(loginB.status).toBe(200);
  });
});
