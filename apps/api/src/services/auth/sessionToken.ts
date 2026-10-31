import { randomBytes, createHash } from 'node:crypto';

export const SESSION_COOKIE_NAME = 'agentproof_session';

export function createSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): string {
  if (typeof token !== 'string') return '';
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function readSessionTokenFromCookieHeader(cookieHeader: string | undefined | null): string | null {
  if (!cookieHeader || typeof cookieHeader !== 'string') return null;
  // Simple parser
  const parts = cookieHeader.split(';');
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i].trim();
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const name = p.slice(0, eq).trim();
    if (name !== SESSION_COOKIE_NAME) continue;
    const value = p.slice(eq + 1).trim();
    if (!value) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

export interface SessionCookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'strict' | 'lax' | 'none';
  path: string;
  maxAge?: number;
  expires?: Date;
}

export function buildSessionCookieOptions(params: { secure: boolean; maxAgeMs: number; expiresAt: string }): SessionCookieOptions {
  return {
    httpOnly: true,
    secure: params.secure,
    sameSite: 'strict',
    path: '/',
    // Express's res.cookie() treats maxAge as milliseconds and derives both
    // Expires and the serialized Max-Age (seconds) from it.
    maxAge: Math.max(0, Math.floor(params.maxAgeMs)),
    expires: new Date(params.expiresAt),
  };
}
