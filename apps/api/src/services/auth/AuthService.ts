import { createSessionToken, hashSessionToken } from './sessionToken.js';
import { hashPassword, verifyPasswordWithDummyOnUnknown } from './passwordHasher.js';
import type { UserRepository } from './UserRepository.js';
import type { SessionRepository } from './SessionRepository.js';
import { generateId } from '../../utils/id.js';
import { normalizeEmail } from './UserRepository.js';

export interface AuthServiceDeps {
  users: UserRepository;
  sessions: SessionRepository;
  sessionTtlMs: number;
  now?: () => Date;
  tokenFactory?: () => string;
}

export interface LoginResult {
  user: { id: string; email: string };
  token: string;
  expiresAt: string;
}

export interface AuthSession {
  user: { id: string; email: string };
  sessionId: string;
  expiresAt: string;
}

export class AuthService {
  private readonly deps: AuthServiceDeps;

  constructor(deps: AuthServiceDeps) {
    this.deps = deps;
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  async login(email: string, password: string): Promise<LoginResult | null> {
    try {
      const normalized = normalizeEmail(email);
      const credentials = await this.deps.users.getCredentialsByEmail(normalized);
      if (!credentials) {
        await verifyPasswordWithDummyOnUnknown(password, null);
        return null;
      }
      const ok = await verifyPasswordWithDummyOnUnknown(password, credentials.passwordHash);
      if (!ok) {
        return null;
      }
      const token = this.deps.tokenFactory ? this.deps.tokenFactory() : createSessionToken();
      const tokenHash = hashSessionToken(token);
      const now = this.now();
      const expiresAt = new Date(now.getTime() + this.deps.sessionTtlMs).toISOString();
      const sessionId = generateId();
      await this.deps.sessions.create({
        id: sessionId,
        userId: credentials.id,
        tokenHash,
        createdAt: now.toISOString(),
        expiresAt,
        revokedAt: null,
      });
      return {
        user: { id: credentials.id, email: credentials.email },
        token,
        expiresAt,
      };
    } catch {
      return null;
    }
  }

  async logout(token: string): Promise<void> {
    try {
      if (typeof token !== 'string' || token.length === 0) return;
      const tokenHash = hashSessionToken(token);
      const now = this.now().toISOString();
      await this.deps.sessions.revoke(tokenHash, now);
    } catch {
      // best effort
    }
  }

  async authenticate(token: string): Promise<AuthSession | null> {
    try {
      if (typeof token !== 'string' || token.length === 0) return null;
      const tokenHash = hashSessionToken(token);
      const now = this.now().toISOString();
      const session = await this.deps.sessions.getActiveByTokenHash(tokenHash, now);
      if (!session) return null;
      const user = await this.deps.users.getById(session.userId);
      if (!user) return null;
      return {
        user: { id: user.id, email: user.email },
        sessionId: session.id,
        expiresAt: session.expiresAt,
      };
    } catch {
      return null;
    }
  }

  async provisionInitialUser(email: string, password: string): Promise<{ created: boolean; userId: string | null }> {
    try {
      const normalized = normalizeEmail(email);
      if (typeof password !== 'string' || password.length < 12) {
        throw new Error('Initial user password must be at least 12 characters');
      }
      const existing = await this.deps.users.getByEmail(normalized);
      if (existing) {
        return { created: false, userId: existing.id };
      }
      const passwordHash = await hashPassword(password);
      const now = this.now().toISOString();
      const userId = generateId();
      await this.deps.users.create({
        id: userId,
        email: normalized,
        createdAt: now,
        passwordHash,
      });
      return { created: true, userId };
    } catch (err) {
      throw err;
    }
  }
}
