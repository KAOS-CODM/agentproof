import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  createIntent,
  getSession,
  login,
  logout,
  setSessionExpiredHandler,
} from './api';

interface StubResponse {
  status: number;
  body?: unknown;
}

function stubFetch(response: StubResponse) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(response.body === undefined ? null : JSON.stringify(response.body), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setSessionExpiredHandler(null);
});

describe('frontend auth request handling', () => {
  it('sends login credentials with cookies and does not report a normal 401 as an expired session', async () => {
    const calls = stubFetch({ status: 401, body: { error: 'Invalid email or password' } });
    const expired = vi.fn();
    setSessionExpiredHandler(expired);

    const error = await login('user@example.com', 'wrong-password').catch((err) => err);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect(expired).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/v1/auth/login');
    expect(calls[0].init).toMatchObject({
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({ email: 'user@example.com', password: 'wrong-password' }),
    });
  });

  it('treats an unauthenticated initial session probe as signed out, not expired', async () => {
    stubFetch({ status: 401, body: { error: 'Authentication required' } });
    const expired = vi.fn();
    setSessionExpiredHandler(expired);

    await expect(getSession()).rejects.toMatchObject({ status: 401 });
    expect(expired).not.toHaveBeenCalled();
  });

  it('notifies the app once when an authenticated request loses its session', async () => {
    stubFetch({ status: 401, body: { error: 'Authentication required' } });
    const expired = vi.fn();
    setSessionExpiredHandler(expired);

    const error = await createIntent('buy running shoes').catch((err) => err);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('preserves 403 authorization failures for the UI without treating them as expiry', async () => {
    stubFetch({ status: 403, body: { error: 'Forbidden' } });
    const expired = vi.fn();
    setSessionExpiredHandler(expired);

    const error = await createIntent('buy running shoes').catch((err) => err);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect((error as ApiError).message).toBe('Forbidden');
    expect(expired).not.toHaveBeenCalled();
  });

  it('logs out with a credentialed POST and never exposes a token in the body', async () => {
    const calls = stubFetch({ status: 204 });

    await logout();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/v1/auth/logout');
    expect(calls[0].init).toMatchObject({ method: 'POST', credentials: 'include' });
    expect(calls[0].init?.body).toBeUndefined();
  });
});
