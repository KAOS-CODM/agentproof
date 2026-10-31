import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OfferSnapshotView } from '@agentproof/shared';
import { requestRetailerHandoff } from './api';

const snapshot: OfferSnapshotView = {
  id: 'snap-1',
  source: 'channel3',
  productId: 'channel3:runfalcon',
  externalProductId: '1FesGXD',
  productName: 'Runfalcon 3.0',
  brand: 'adidas',
  merchant: 'shoebacca.com',
  price: 44.95,
  currency: 'USD',
  availability: 'InStock',
  condition: 'new',
  compareAtPrice: 65,
  maxCommissionRate: 0.05,
  capturedAt: '2026-10-20T10:00:00.000Z',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('retailer handoff API', () => {
  it('sends the exact displayed snapshot identity', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        return new Response(
          JSON.stringify({ url: 'https://shoebacca.com/p/1', disclosure: 'x', offer: snapshot }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );

    await requestRetailerHandoff('intent/1', snapshot);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/api/v1/products/handoff');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      intentId: 'intent/1',
      source: 'channel3',
      productId: 'channel3:runfalcon',
      snapshotId: 'snap-1',
    });
  });
});
