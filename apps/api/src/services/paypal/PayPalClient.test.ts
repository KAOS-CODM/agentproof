import { describe, it, expect, vi, afterEach } from 'vitest';
import { PayPalClient, PayPalError, PayPalNotConfiguredError } from './PayPalClient.js';

const client = () => new PayPalClient('test-client-id', 'test-secret-value', 'https://api-m.sandbox.paypal.com');

function tokenResponse() {
  return { ok: true, headers: new Headers(), json: async () => ({ access_token: 'tok-abc', expires_in: 3600 }) };
}

function stubFetchSequence(responses: Array<() => unknown>) {
  const mock = vi.fn(async (..._args: unknown[]) => responses.shift()!());
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => vi.unstubAllGlobals());

describe('PayPalClient getOrder / captureOrder', () => {
  it('successful order retrieval returns typed details', async () => {
    const mock = stubFetchSequence([
      tokenResponse,
      () => ({
        ok: true, headers: new Headers(),
        json: async () => ({
          id: 'O-1', status: 'APPROVED', intent: 'CAPTURE',
          purchase_units: [{ invoice_id: 'inv-1', amount: { currency_code: 'USD', value: '99.00' } }],
        }),
      }),
    ]);

    const order = await client().getOrder('O-1');
    expect(order.id).toBe('O-1');
    expect(order.status).toBe('APPROVED');
    expect(order.invoiceId).toBe('inv-1');
    expect(order.amount).toBe(99);
    expect(order.currency).toBe('USD');
    expect(String(mock.mock.calls[1][0])).toBe('https://api-m.sandbox.paypal.com/v2/checkout/orders/O-1');
  });

  it('successful capture returns typed capture result', async () => {
    stubFetchSequence([
      tokenResponse,
      () => ({
        ok: true, headers: new Headers(),
        json: async () => ({
          id: 'O-1', status: 'COMPLETED',
          purchase_units: [{ payments: { captures: [{ id: 'CAP-1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '99.00' } }] } }],
        }),
      }),
    ]);

    const capture = await client().captureOrder('O-1');
    expect(capture.orderId).toBe('O-1');
    expect(capture.orderStatus).toBe('COMPLETED');
    expect(capture.captureId).toBe('CAP-1');
    expect(capture.captureStatus).toBe('COMPLETED');
    expect(capture.amount).toBe(99);
  });

  it('capture failure surfaces PayPal error with debug id', async () => {
    stubFetchSequence([
      tokenResponse,
      () => ({ ok: false, status: 422, headers: new Headers({ 'paypal-debug-id': 'dbg-c' }), text: async () => 'ORDER_ALREADY_CAPTURED' }),
    ]);

    const err = await client().captureOrder('O-1').catch((e) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect(err.message).toContain('422');
    expect(err.debugId).toBe('dbg-c');
  });

  it('malformed get-order response throws', async () => {
    stubFetchSequence([
      tokenResponse,
      () => ({ ok: true, headers: new Headers(), json: async () => ({ nope: 1 }) }),
    ]);

    await expect(client().getOrder('O-1')).rejects.toThrow('malformed');
  });
});

describe('PayPalClient OAuth', () => {
  it('1. acquires a token via client credentials with Basic auth', async () => {
    const mock = stubFetchSequence([
      tokenResponse,
      () => ({ ok: true, headers: new Headers(), json: async () => ({ id: 'O-1', status: 'CREATED', links: [] }) }),
    ]);

    await client().createOrder({ amount: 10, currency: 'USD', description: 'x', invoiceId: 'inv-1' });

    const [url, init] = mock.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe('https://api-m.sandbox.paypal.com/v1/oauth2/token');
    expect(init.headers.Authorization).toMatch(/^Basic /);
    expect(init.body).toBe('grant_type=client_credentials');
    expect(Buffer.from(init.headers.Authorization.slice(6), 'base64').toString()).toBe('test-client-id:test-secret-value');
  });

  it('2. reuses a valid cached token', async () => {
    const mock = stubFetchSequence([
      tokenResponse,
      () => ({ ok: true, headers: new Headers(), json: async () => ({ id: 'O-1', status: 'CREATED', links: [] }) }),
      () => ({ ok: true, headers: new Headers(), json: async () => ({ id: 'O-2', status: 'CREATED', links: [] }) }),
    ]);

    const c = client();
    await c.createOrder({ amount: 10, currency: 'USD', description: 'x', invoiceId: 'i1' });
    await c.createOrder({ amount: 20, currency: 'USD', description: 'y', invoiceId: 'i2' });

    const tokenCalls = mock.mock.calls.filter((c) => String(c[0]).includes('oauth2/token'));
    expect(tokenCalls.length).toBe(1);
  });

  it('3. OAuth failure throws clear error without leaking secret', async () => {
    stubFetchSequence([() => ({ ok: false, status: 401, headers: new Headers({ 'paypal-debug-id': 'dbg-1' }), text: async () => 'invalid_client' })]);

    const err = await client()
      .createOrder({ amount: 10, currency: 'USD', description: 'x', invoiceId: 'i' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect(err.message).toContain('401');
    expect(err.debugId).toBe('dbg-1');
    expect(err.message).not.toContain('test-secret-value');
  });
});

describe('PayPalClient createOrder', () => {
  it('4. successful order creation returns typed result and sends CAPTURE payload', async () => {
    const mock = stubFetchSequence([
      tokenResponse,
      () => ({
        ok: true, headers: new Headers(),
        json: async () => ({ id: 'O-XYZ', status: 'CREATED', links: [{ rel: 'approve', href: 'https://paypal.com/approve/O-XYZ' }] }),
      }),
    ]);

    const order = await client().createOrder({ amount: 99.5, currency: 'USD', description: 'Shoe', invoiceId: 'inv-9' });
    expect(order.id).toBe('O-XYZ');
    expect(order.status).toBe('CREATED');
    expect(order.approveUrl).toContain('O-XYZ');

    const [url, init] = mock.mock.calls[1] as unknown as [string, { body: string; headers: Record<string, string> }];
    expect(url).toBe('https://api-m.sandbox.paypal.com/v2/checkout/orders');
    expect(init.headers.Authorization).toBe('Bearer tok-abc');
    const body = JSON.parse(init.body);
    expect(body.intent).toBe('CAPTURE');
    expect(body.purchase_units[0].amount).toEqual({ currency_code: 'USD', value: '99.50' });
    expect(body.purchase_units[0].invoice_id).toBe('inv-9');
  });

  it('5. PayPal non-2xx order response yields clear error with debug id', async () => {
    stubFetchSequence([
      tokenResponse,
      () => ({ ok: false, status: 422, headers: new Headers({ 'paypal-debug-id': 'dbg-422' }), text: async () => 'UNPROCESSABLE_ENTITY' }),
    ]);

    const err = await client().createOrder({ amount: 1, currency: 'USD', description: 'x', invoiceId: 'i' }).catch((e) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect(err.message).toContain('422');
    expect(err.debugId).toBe('dbg-422');
  });

  it('6. malformed PayPal response throws parse error', async () => {
    stubFetchSequence([
      tokenResponse,
      () => ({ ok: true, headers: new Headers(), json: async () => ({ unexpected: true }) }),
    ]);

    await expect(client().createOrder({ amount: 1, currency: 'USD', description: 'x', invoiceId: 'i' })).rejects.toThrow('malformed');
  });

  it('7. missing configuration fails before any request', async () => {
    const mock = stubFetchSequence([]);
    const c = new PayPalClient('', '', 'https://api-m.sandbox.paypal.com');
    await expect(c.createOrder({ amount: 1, currency: 'USD', description: 'x', invoiceId: 'i' })).rejects.toBeInstanceOf(PayPalNotConfiguredError);
    expect(mock).not.toHaveBeenCalled();
  });

  it('8. token Authorization header never appears in error messages', async () => {
    stubFetchSequence([
      tokenResponse,
      () => ({ ok: false, status: 500, headers: new Headers(), text: async () => 'boom' }),
    ]);

    const err = await client().createOrder({ amount: 1, currency: 'USD', description: 'x', invoiceId: 'i' }).catch((e) => e);
    expect(err.message).not.toContain('tok-abc');
    expect(err.message).not.toContain('Bearer');
  });
});
