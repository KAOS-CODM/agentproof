import { Router } from 'express';
import { z } from 'zod';
import { getUserRepository, getSessionRepository } from '../models/repositories.js';
import { AuthService } from '../services/auth/AuthService.js';
import { hashPassword } from '../services/auth/passwordHasher.js';
import { normalizeEmail } from '../services/auth/UserRepository.js';
import { generateId } from '../utils/id.js';
import { config } from '../config/env.js';
import {
  SESSION_COOKIE_NAME,
  buildSessionCookieOptions,
  readSessionTokenFromCookieHeader,
} from '../services/auth/sessionToken.js';
import { requireAuth } from '../middleware/auth.js';

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
});

const registerSchema = z.object({
  email: z.string().min(1).max(320).email(),
  password: z.string().min(12).max(1024),
});

const sessionTtlMs = config.authSessionTtlMs;

function getAuthService(): AuthService {
  return new AuthService({
    users: getUserRepository(),
    sessions: getSessionRepository(),
    sessionTtlMs,
  });
}

authRouter.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }
  const { email, password } = parsed.data;
  const result = await getAuthService().login(email, password);
  if (!result) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }
  const opts = buildSessionCookieOptions({
    secure: config.authCookieSecure,
    maxAgeMs: sessionTtlMs,
    expiresAt: result.expiresAt,
    sameSite: config.authCookieSameSite,
  });
  res.cookie(SESSION_COOKIE_NAME, result.token, opts as any);
  res.json({ user: result.user, expiresAt: result.expiresAt });
});

authRouter.post('/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }
  const { email, password } = parsed.data;
  const normalized = normalizeEmail(email);
  try {
    const existing = await getUserRepository().getByEmail(normalized);
    if (existing) {
      res.status(409).json({ error: 'Email already registered' });
      return;
    }
    const passwordHash = await hashPassword(password);
    const userId = generateId();
    await getUserRepository().create({
      id: userId,
      email: normalized,
      createdAt: new Date().toISOString(),
      passwordHash,
    });
    // Auto-login the new user through the normal session mechanism.
    const authService = getAuthService();
    const loginResult = await authService.login(normalized, password);
    if (!loginResult) {
      res.status(500).json({ error: 'Registration succeeded but login failed' });
      return;
    }
    const opts = buildSessionCookieOptions({
      secure: config.authCookieSecure,
      maxAgeMs: sessionTtlMs,
      expiresAt: loginResult.expiresAt,
      sameSite: config.authCookieSameSite,
    });
    res.cookie(SESSION_COOKIE_NAME, loginResult.token, opts as any);
    res.status(201).json({
      user: { id: loginResult.user.id, email: loginResult.user.email },
      expiresAt: loginResult.expiresAt,
    });
  } catch (err) {
    // Duplicate-email error from the repository (or a race after the pre-check).
    if (
      err instanceof Error &&
      /already exists|duplicate key|unique constraint|E11000/i.test(err.message)
    ) {
      res.status(409).json({ error: 'Email already registered' });
    } else {
      res.status(500).json({ error: 'Registration failed' });
    }
  }
});

authRouter.post('/logout', async (req, res) => {
  const token = readSessionTokenFromCookieHeader(req.headers.cookie);
  await getAuthService().logout(token || '');
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: config.authCookieSecure,
    sameSite: config.authCookieSameSite,
    path: '/',
  } as any);
  res.status(204).end();
});

authRouter.get('/session', requireAuth, async (req, res) => {
  const auth = req.auth!;
  res.json({ user: auth.user, expiresAt: auth.expiresAt, sessionId: auth.sessionId });
});
