import type { Request, Response, NextFunction } from 'express';
import { readSessionTokenFromCookieHeader } from '../services/auth/sessionToken.js';
import { getSessionRepository, getUserRepository } from '../models/repositories.js';
import { hashSessionToken } from '../services/auth/sessionToken.js';

export interface AuthContext {
  user: { id: string; email: string };
  sessionId: string;
  expiresAt: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = readSessionTokenFromCookieHeader(req.headers.cookie);
    if (!token) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const tokenHash = hashSessionToken(token);
    const now = new Date().toISOString();
    const session = await getSessionRepository().getActiveByTokenHash(tokenHash, now);
    if (!session) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const user = await getUserRepository().getById(session.userId);
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    req.auth = {
      user: { id: user.id, email: user.email },
      sessionId: session.id,
      expiresAt: session.expiresAt,
    };
    next();
  } catch {
    res.status(401).json({ error: 'Authentication required' });
  }
}

export function optionalAuth() {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const token = readSessionTokenFromCookieHeader(req.headers.cookie);
      if (!token) {
        next();
        return;
      }
      const tokenHash = hashSessionToken(token);
      const now = new Date().toISOString();
      const session = await getSessionRepository().getActiveByTokenHash(tokenHash, now);
      if (!session) {
        next();
        return;
      }
      const user = await getUserRepository().getById(session.userId);
      if (!user) {
        next();
        return;
      }
      req.auth = {
        user: { id: user.id, email: user.email },
        sessionId: session.id,
        expiresAt: session.expiresAt,
      };
      next();
    } catch {
      next();
    }
  };
}
