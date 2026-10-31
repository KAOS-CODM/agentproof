import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  getDiscoveries,
  getIntent,
  listIntents,
  listTransactions,
  setSessionExpiredHandler,
} from './api';

interface StubResponse {
  status: number;
  body?: unknown;
}

function stubSequence(responses: StubResponse[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let index = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
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

describe('saved workflow API requests', () => {
  it('requests credentialed, encoded history and discovery endpoints', async () => {
    const calls = stubSequence([
      { status: 200, body: [] },
      { status: 200, body: [] },
      { status: 200, body: { id: 'intent/1' } },
      { status: 200, body: { intentId: 'intent/1' } },
    ]);

    await listIntents(10);
    await listTransactions('intent/1', 7);
    await getIntent('intent/1');
    await getDiscoveries('intent/1');

    expect(calls.map((call) => call.url)).toEqual([
      '/api/v1/intent?limit=10',
      '/api/v1/payments/history?limit=7&intentId=intent%2F1',
      '/api/v1/intent/intent%2F1',
      '/api/v1/products/discoveries/intent%2F1',
    ]);
    for (const call of calls) {
      expect(call.init?.credentials).toBe('include');
    }
  });

  it('omits the intent filter for all-user transaction history', async () => {
    const calls = stubSequence([{ status: 200, body: [] }]);
    await listTransactions(undefined, 50);
    expect(calls[0].url).toBe('/api/v1/payments/history?limit=50');
  });

  it('notifies the session-expired handler for a protected history 401', async () => {
    stubSequence([{ status: 401, body: { error: 'Authentication required' } }]);
    const expired = vi.fn();
    setSessionExpiredHandler(expired);

    await expect(listIntents()).rejects.toBeInstanceOf(ApiError);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('preserves an authorization 403 without reporting an expired session', async () => {
    stubSequence([{ status: 403, body: { error: 'Forbidden' } }]);
    const expired = vi.fn();
    setSessionExpiredHandler(expired);

    await expect(listTransactions('intent-1')).rejects.toMatchObject({
      status: 403,
      message: 'Forbidden',
    });
    expect(expired).not.toHaveBeenCalled();
  });
});
