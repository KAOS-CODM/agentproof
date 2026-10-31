import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config/env.js';
import { csrfProtection } from './csrf.js';

interface MockResponse {
  statusCode: number | null;
  body: unknown;
  status: (code: number) => MockResponse;
  json: (value: unknown) => MockResponse;
}

function mockResponse(): MockResponse {
  const res: MockResponse = {
    statusCode: null,
    body: null,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(value: unknown) {
      res.body = value;
      return res;
    },
  };
  return res;
}

function run(headers: Record<string, string>, method = 'POST') {
  const req = {
    method,
    headers,
    protocol: 'http',
  } as unknown as Request;
  const res = mockResponse();
  const next = vi.fn();
  csrfProtection(req, res as unknown as Response, next as unknown as NextFunction);
  return { next, res };
}

const originalWebOrigin = config.webOrigin;

beforeEach(() => {
  config.webOrigin = 'https://app.example.com';
});

afterEach(() => {
  config.webOrigin = originalWebOrigin;
});

describe('CSRF origin protection', () => {
  it('never blocks safe methods', () => {
    const { next, res } = run({ origin: 'https://evil.example' }, 'GET');
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeNull();
  });

  it('allows a state-changing request from the configured web origin', () => {
    const { next, res } = run({ origin: 'https://app.example.com' });
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeNull();
  });

  it('allows a same-origin request when its host matches', () => {
    const { next, res } = run({ origin: 'http://localhost:3001', host: 'localhost:3001' });
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeNull();
  });

  it('rejects a state-changing request from another origin', () => {
    const { next, res } = run({ origin: 'https://evil.example' });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
  });

  it('checks the referer origin when no Origin header is present', () => {
    const allowed = run({ referer: 'https://app.example.com/payment/return' });
    expect(allowed.next).toHaveBeenCalledOnce();

    const denied = run({ referer: 'https://evil.example/attack' });
    expect(denied.next).not.toHaveBeenCalled();
    expect(denied.res.statusCode).toBe(403);
  });

  it('leaves non-browser requests without either header to the SameSite cookie policy', () => {
    const { next, res } = run({});
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeNull();
  });
});
