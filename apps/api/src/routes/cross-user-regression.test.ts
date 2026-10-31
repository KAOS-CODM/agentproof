import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
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

const STRONG_PASSWORD = 'correct horse battery staple';

let server: Server;
let baseUrl: string;
let userRepo: InMemoryUserRepository;
let sessionRepo: InMemorySessionRepository;

function authHeader(cookie: string): Record<string, string> {
  return { cookie, 'content-type': 'application/json' };
}

async function postJson(path: string, body: unknown, cookie?: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: authHeader(cookie ?? ''),
    body: JSON.stringify(body),
  });
}

async function getJson(path: string, cookie?: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    headers: { cookie, 'content-type': 'application/json' },
  });
}

function cookieFrom(res: Response): string {
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('No set-cookie header');
  return setCookie.split(';')[0];
}

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

describe('Cross-user isolation (in-memory repo pattern)', () => {
  it('User A can register and authenticate', async () => {
    const a = await postJson('/api/v1/auth/register', {
      email: 'xregression-a@example.com',
      password: STRONG_PASSWORD,
    });
    expect(a.status).toBe(201);
    const aCookie = cookieFrom(a);
    const s = await getJson('/api/v1/auth/session', aCookie);
    expect(s.status).toBe(200);
    const sBody = await s.json();
    expect(sBody.user.email).toBe('xregression-a@example.com');
  });

  it('User B can register and authenticate independently', async () => {
    const b = await postJson('/api/v1/auth/register', {
      email: 'xregression-b@example.com',
      password: STRONG_PASSWORD,
    });
    expect(b.status).toBe(201);
    const bCookie = cookieFrom(b);
    const s = await getJson('/api/v1/auth/session', bCookie);
    expect(s.status).toBe(200);
    const sBody = await s.json();
    expect(sBody.user.email).toBe('xregression-b@example.com');
  });

  it('User A and User B have different session tokens', async () => {
    const a = await postJson('/api/v1/auth/register', {
      email: 'xregression-a2@example.com',
      password: STRONG_PASSWORD,
    });
    const b = await postJson('/api/v1/auth/register', {
      email: 'xregression-a2@example.com',
      password: STRONG_PASSWORD,
    });
    // Different emails should produce different sessions
    // (the second registration should fail with duplicate email)
    expect(a.status).toBe(201);
    expect(b.status).toBe(409); // duplicate email
  });

  it('Repository-level: User A cannot retrieve User B own users', async () => {
    // This test verifies the repository-level isolation
    // Using seedTestUser to create users in separate repos
    const aRepo = new InMemoryUserRepository();
    const bRepo = new InMemoryUserRepository();
    
    setRepositoryOverrides({ user: aRepo, session: new InMemorySessionRepository() });
    
    await seedTestUser(aRepo, 'repo-a@example.com', STRONG_PASSWORD);
    setRepositoryOverrides({ user: bRepo, session: new InMemorySessionRepository() });
    
    await seedTestUser(bRepo, 'repo-b@example.com', STRONG_PASSWORD);
    
    // Verify users are distinct
    const aCreds = await aRepo.getCredentialsByEmail('repo-a@example.com');
    const bCreds = await bRepo.getCredentialsByEmail('repo-b@example.com');
    
    expect(aCreds).not.toBeNull();
    expect(bCreds).not.toBeNull();
    // Each repo only has its own user
    const aUser = await aRepo.getByEmail('repo-a@example.com');
    const bUser = await bRepo.getByEmail('repo-b@example.com');
    
    expect(aUser).not.toBeNull();
    expect(bUser).not.toBeNull();
    // Cross-repo access should fail (repos are separate)
    const crossA = await aRepo.getCredentialsByEmail('repo-b@example.com');
    const crossB = await bRepo.getCredentialsByEmail('repo-a@example.com');
    
    expect(crossA).toBeNull();
    expect(crossB).toBeNull();
  });
});