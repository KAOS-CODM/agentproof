import { describe, it, expect, vi, afterEach } from 'vitest';
import type { StructuredIntent } from '@agentproof/shared';
import {
  Channel3Service,
  Channel3NotConfiguredError,
  Channel3ApiError,
  Channel3TransportError,
  Channel3ResponseError,
} from './Channel3Service.js';

function makeIntent(overrides: Partial<StructuredIntent> = {}): StructuredIntent {
  return {
    purpose: 'running shoes',
    maxAmount: 150,
    currency: 'USD',
    brands: [],
    condition: 'new',
    requiresConfirmationAbove: null,
    constraints: [],
    ...overrides,
  };
}

function offer(overrides: Record<string, unknown> = {}) {
  return {
    url: 'https://buy.trychannel3.com/abc',
    domain: 'shoebacca.com',
    price: { price: 44.95, compare_at_price: 65, currency: 'USD' },
    availability: 'InStock',
    condition: 'new',
    max_commission_rate: 0.05,
    ...overrides,
  };
}

function channel3Product(overrides: Record<string, unknown> = {}) {
  return {
    id: '1FesGXD',
    title: 'Runfalcon 3.0 Running Shoes',
    description: 'Lightweight running shoes designed for everyday training.',
    brands: [{ id: 'MJDR', name: 'adidas' }],
    images: [
      { url: 'https://cdn.example/hero.jpg', cleaned_url: 'https://cdn.example/clean-hero.jpg', is_main_image: true },
      { url: 'https://cdn.example/detail.jpg', cleaned_url: null, is_main_image: false },
    ],
    category: {
      slug: 'athletic-shoes',
      title: 'Athletic Shoes',
      path: [
        { slug: 'apparel-accessories', title: 'Apparel & Accessories' },
        { slug: 'shoes', title: 'Shoes' },
        { slug: 'athletic-shoes', title: 'Athletic Shoes' },
      ],
      has_children: false,
    },
    offers: [offer()],
    structured_attributes: { activity: ['Running'] },
    ...overrides,
  };
}

function stubJsonOnce(payload: unknown): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => ({ ok: true, status: 200, json: async () => payload }));
  vi.stubGlobal('fetch', mock);
  return mock;
}

function stubFetchOnce(impl: (...args: unknown[]) => Promise<unknown>): ReturnType<typeof vi.fn> {
  const mock = vi.fn(impl);
  vi.stubGlobal('fetch', mock);
  return mock;
}

function callOf(mock: ReturnType<typeof vi.fn>): { url: string; init: Record<string, unknown> } {
  const [url, init] = mock.mock.calls[0] as [string, Record<string, unknown>];
  return { url, init };
}

afterEach(() => vi.unstubAllGlobals());

describe('Channel3Service configuration', () => {
  it('throws Channel3NotConfiguredError without a key and never calls fetch', async () => {
    const mock = vi.fn();
    vi.stubGlobal('fetch', mock);
    await expect(new Channel3Service('').search(makeIntent())).rejects.toBeInstanceOf(
      Channel3NotConfiguredError,
    );
    await expect(new Channel3Service(undefined).search(makeIntent())).rejects.toBeInstanceOf(
      Channel3NotConfiguredError,
    );
    expect(mock).not.toHaveBeenCalled();
  });
});

describe('Channel3Service request format', () => {
  it('posts the documented request without leaking the key into the body', async () => {
    const mock = stubJsonOnce({ products: [channel3Product()], next_page_token: null });

    await new Channel3Service('secret-key-value').search(
      makeIntent({ purpose: 'running shoes', brands: ['Nike'], condition: 'any' }),
    );

    const { url, init } = callOf(mock);
    expect(url).toBe('https://api.trychannel3.com/v1/search');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('secret-key-value');

    const body = JSON.parse(init.body as string);
    expect(body.query).toContain('running shoes');
    expect(body.filters.conditions).toEqual(['new', 'used']);
    expect(body.filters.availability).toEqual(['InStock']);
    expect(body.config.currency).toBe('USD');
    expect(init.body).not.toContain('secret-key-value');
  });

  it('maps the intent condition to Channel3 conditions and price bounds', async () => {
    const mock = stubJsonOnce({ products: [], next_page_token: null });
    await new Channel3Service('k').search(
      makeIntent({
        condition: 'used',
        maxAmount: 200,
        constraints: [{ type: 'price', value: 50, operator: 'gte' }],
      }),
    );
    const body = JSON.parse(callOf(mock).init.body as string);
    expect(body.filters.conditions).toEqual(['used']);
    expect(body.filters.price).toEqual({ min_price: 50, max_price: 200 });
  });

  it('omits config.currency for currencies Channel3 does not support', async () => {
    const mock = stubJsonOnce({ products: [], next_page_token: null });
    await new Channel3Service('k').search(makeIntent({ currency: 'JPY' }));
    const body = JSON.parse(callOf(mock).init.body as string);
    expect(body.config.currency).toBeUndefined();
  });
});

describe('Channel3Service response mapping', () => {
  it('maps a real-shaped product into the normalized product model', async () => {
    stubJsonOnce({ products: [channel3Product()], next_page_token: null });

    const products = await new Channel3Service('k').search(makeIntent());
    expect(products).toHaveLength(1);

    expect(products[0]).toMatchObject({
      id: 'channel3:1FesGXD',
      source: 'channel3',
      name: 'Runfalcon 3.0 Running Shoes',
      description: 'Lightweight running shoes designed for everyday training.',
      price: 44.95,
      currency: 'USD',
      brand: 'adidas',
      condition: 'new',
      category: 'Athletic Shoes',
      merchant: 'shoebacca.com',
      imageUrl: 'https://cdn.example/clean-hero.jpg',
      productUrl: 'https://buy.trychannel3.com/abc',
      availability: 'InStock',
      externalId: '1FesGXD',
      brandId: 'MJDR',
      metadata: {
        provider: 'channel3',
        offerDomain: 'shoebacca.com',
        compareAtPrice: 65,
        maxCommissionRate: 0.05,
      },
    });
  });

  it('falls back to the regular image when no cleaned_url is present', async () => {
    stubJsonOnce({
      products: [
        channel3Product({
          images: [{ url: 'https://cdn.example/only.jpg', cleaned_url: null, is_main_image: true }],
        }),
      ],
    });
    const products = await new Channel3Service('k').search(makeIntent());
    expect(products[0].imageUrl).toBe('https://cdn.example/only.jpg');
  });

  it('maps a null offer condition to unknown, never new', async () => {
    stubJsonOnce({ products: [channel3Product({ offers: [offer({ condition: null })] })] });
    const products = await new Channel3Service('k').search(makeIntent());
    expect(products[0].condition).toBe('unknown');
  });

  it('maps a refurbished offer condition to unknown', async () => {
    stubJsonOnce({ products: [channel3Product({ offers: [offer({ condition: 'refurbished' })] })] });
    const products = await new Channel3Service('k').search(makeIntent());
    expect(products[0].condition).toBe('unknown');
  });

  it('skips products with no offer in the intent currency (no cross-currency comparison)', async () => {
    stubJsonOnce({
      products: [
        channel3Product({ offers: [offer({ price: { price: 40, currency: 'EUR' } })] }),
      ],
    });
    const products = await new Channel3Service('k').search(makeIntent({ currency: 'USD' }));
    expect(products).toHaveLength(0);
  });

  it('prefers InStock over a cheaper OutOfStock offer', async () => {
    stubJsonOnce({
      products: [
        channel3Product({
          offers: [
            offer({ domain: 'cheap.com', availability: 'OutOfStock', price: { price: 10, currency: 'USD' } }),
            offer({ domain: 'stocked.com', availability: 'InStock', price: { price: 80, currency: 'USD' } }),
          ],
        }),
      ],
    });
    const products = await new Channel3Service('k').search(makeIntent());
    expect(products[0].merchant).toBe('stocked.com');
    expect(products[0].price).toBe(80);
  });

  it('skips products missing a brand or a category without fabricating values', async () => {
    stubJsonOnce({
      products: [
        channel3Product({ id: 'no-brand', brands: [] }),
        channel3Product({ id: 'no-category', category: null }),
      ],
    });
    const products = await new Channel3Service('k').search(makeIntent());
    expect(products).toHaveLength(0);
  });

  it('defaults a missing description to an empty string (never invents text)', async () => {
    stubJsonOnce({ products: [channel3Product({ description: null })] });
    const products = await new Channel3Service('k').search(makeIntent());
    expect(products[0].description).toBe('');
  });
});

describe('Channel3Service error handling', () => {
  it('throws a configuration-flavoured Channel3ApiError for 401 without echoing the key', async () => {
    stubFetchOnce(async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }));

    const err = await new Channel3Service('secret-key-value').search(makeIntent()).catch((e) => e);

    expect(err).toBeInstanceOf(Channel3ApiError);
    expect(err.status).toBe(401);
    expect(err.message).toContain('CHANNEL3_API_KEY');
    expect(err.message).not.toContain('secret-key-value');
  });

  it('reports rate limits distinctly (429)', async () => {
    stubFetchOnce(async () => ({ ok: false, status: 429, text: async () => 'slow down' }));
    const err = await new Channel3Service('k').search(makeIntent()).catch((e) => e);
    expect(err).toBeInstanceOf(Channel3ApiError);
    expect(err.status).toBe(429);
    expect(err.message).toMatch(/rate limit/i);
  });

  it('reports other provider errors with their status (500)', async () => {
    stubFetchOnce(async () => ({ ok: false, status: 500, text: async () => 'boom' }));
    const err = await new Channel3Service('k').search(makeIntent()).catch((e) => e);
    expect(err).toBeInstanceOf(Channel3ApiError);
    expect(err.status).toBe(500);
  });

  it('throws Channel3ResponseError for a malformed payload', async () => {
    stubJsonOnce({ products: 'not-an-array' });
    await expect(new Channel3Service('k').search(makeIntent())).rejects.toBeInstanceOf(
      Channel3ResponseError,
    );
  });

  it('throws Channel3ResponseError for a non-JSON response body', async () => {
    stubFetchOnce(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    }));
    await expect(new Channel3Service('k').search(makeIntent())).rejects.toBeInstanceOf(
      Channel3ResponseError,
    );
  });

  it('converts a timeout into a clear Channel3TransportError', async () => {
    stubFetchOnce(async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    });
    const err = await new Channel3Service('k').search(makeIntent()).catch((e) => e);
    expect(err).toBeInstanceOf(Channel3TransportError);
    expect(err.message).toMatch(/timed out/);
  });

  it('enriches transport failures with safe diagnostics only', async () => {
    stubFetchOnce(async () => {
      const e = new TypeError('fetch failed');
      (e as { cause?: unknown }).cause = {
        code: 'ENOTFOUND',
        syscall: 'getaddrinfo',
        hostname: 'api.trychannel3.com',
        message: 'getaddrinfo ENOTFOUND api.trychannel3.com',
      };
      throw e;
    });
    const err = await new Channel3Service('secret-key-value').search(makeIntent()).catch((e) => e);
    expect(err).toBeInstanceOf(Channel3TransportError);
    expect(err.message).toContain('name=TypeError');
    expect(err.message).toContain('code=ENOTFOUND');
    expect(err.message).toContain('hostname=api.trychannel3.com');
    expect(err.message).not.toContain('secret-key-value');
  });
});
