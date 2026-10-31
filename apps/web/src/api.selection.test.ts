import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  createSelection,
  getActiveSelection,
  getSelectionHistory,
  setSessionExpiredHandler,
  type SelectionView,
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

const selection: SelectionView = {
  id: 'sel-1',
  intentId: 'intent/1',
  snapshotId: 'snap-1',
  source: 'channel3',
  productId: 'product-1',
  price: 44.95,
  currency: 'USD',
  isActive: true,
  selectedAt: '2026-10-20T10:00:00.000Z',
  supersededAt: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
  setSessionExpiredHandler(null);
});

describe('selection API requests', () => {
  it('reads the active selection with credentials and an encoded intent id', async () => {
    const calls = stubSequence([{ status: 200, body: { selection } }]);

    const response = await getActiveSelection('intent/1');

    expect(response.selection).toEqual(selection);
    expect(calls[0].url).toBe('/api/v1/selections/intent%2F1');
    expect(calls[0].init?.credentials).toBe('include');
  });

  it('preserves an explicit null active selection', async () => {
    stubSequence([{ status: 200, body: { selection: null } }]);
    await expect(getActiveSelection('intent-1')).resolves.toEqual({ selection: null });
  });

  it('reads selection history from the history endpoint', async () => {
    const calls = stubSequence([{ status: 200, body: { selections: [selection] } }]);

    const response = await getSelectionHistory('intent/1');

    expect(response.selections).toHaveLength(1);
    expect(response.selections[0].id).toBe('sel-1');
    expect(calls[0].url).toBe('/api/v1/selections/intent%2F1/history');
    expect(calls[0].init?.credentials).toBe('include');
  });

  it('posts the intent and exact displayed snapshot identity', async () => {
    const calls = stubSequence([{ status: 201, body: { selection } }]);

    const response = await createSelection(
      'intent/1',
      'channel3',
      'product-1',
      'snap-1',
    );

    expect(response.selection.price).toBe(44.95);
    expect(calls[0].url).toBe('/api/v1/selections');
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      intentId: 'intent/1',
      source: 'channel3',
      productId: 'product-1',
      snapshotId: 'snap-1',
    });
  });

  it('preserves the SELECTION_CONFLICT code instead of adopting another offer', async () => {
    stubSequence([
      {
        status: 409,
        body: {
          error: 'Another selection for this intent was activated concurrently; reload and try again.',
          code: 'SELECTION_CONFLICT',
          selection: { ...selection, id: 'sel-other', productId: 'product-2' },
        },
      },
    ]);

    await expect(
      createSelection('intent-1', 'channel3', 'product-1', 'snap-1'),
    ).rejects.toMatchObject({
      status: 409,
      code: 'SELECTION_CONFLICT',
    });
  });

  it('preserves the NO_SNAPSHOT code for legacy offers', async () => {
    stubSequence([
      {
        status: 409,
        body: {
          error: 'No immutable offer snapshot is available for this product; re-run discovery.',
          code: 'NO_SNAPSHOT',
        },
      },
    ]);

    const error = await createSelection(
      'intent-1',
      'demo_catalog',
      'product-1',
      'snap-1',
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'NO_SNAPSHOT' });
  });

  it('notifies the session-expired handler for a protected selection read', async () => {
    stubSequence([{ status: 401, body: { error: 'Authentication required' } }]);
    const expired = vi.fn();
    setSessionExpiredHandler(expired);

    await expect(getActiveSelection('intent-1')).rejects.toBeInstanceOf(ApiError);
    expect(expired).toHaveBeenCalledTimes(1);
  });
});
