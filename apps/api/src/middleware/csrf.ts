import type { Request, Response, NextFunction } from 'express';
import { config } from '../config/env.js';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function getRequestOrigin(req: Request): string | null {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.length > 0) {
    return origin;
  }
  const referer = req.headers.referer;
  if (typeof referer === 'string' && referer.length > 0) {
    try {
      const u = new URL(referer);
      return u.origin;
    } catch {
      return null;
    }
  }
  return null;
}

function isAllowedOrigin(origin: string, req: Request): boolean {
  const webOrigin = config.webOrigin;
  if (webOrigin && origin === webOrigin) {
    return true;
  }
  try {
    const host = req.headers.host;
    if (host) {
      const protocol = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
      const expected = `${protocol}://${host}`;
      if (origin === expected) return true;
    }
  } catch {
    // ignore
  }
  return false;
}

export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  const method = req.method.toUpperCase();
  if (!UNSAFE_METHODS.has(method)) {
    next();
    return;
  }
  const origin = getRequestOrigin(req);
  if (!origin) {
    // Non-browser clients without origin headers are allowed; cookie-auth relies on SameSite
    next();
    return;
  }
  if (isAllowedOrigin(origin, req)) {
    next();
    return;
  }
  res.status(403).json({ error: 'Forbidden' });
}
