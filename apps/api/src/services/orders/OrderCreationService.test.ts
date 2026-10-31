import { describe, it, expect } from 'vitest';
import type { Product, StructuredIntent } from '@agentproof/shared';
import { OrderCreationService, type PersistedOrder } from './OrderCreationService.js';
import type { ProductResolution } from '../discovery/ProductResolutionService.js';
import { PolicyEngine } from '../policy/PolicyEngine.js';
import { EvidenceService } from '../evidence/EvidenceService.js';
import { InMemoryEvidenceRepository } from '../../test/inMemoryRepositories.js';
import {
  PayPalClient,
  type CreateOrderInput,
  type CreatedOrder,
} from '../paypal/PayPalClient.js';

class StubPayPalClient extends PayPalClient {
  createCalls = 0;
  captureCalls = 0;
  createInputs: CreateOrderInput[] = [];
  constructor(private readonly order: CreatedOrder) {
    super('client-id', 'client-secret', 'https://api-m.sandbox.paypal.com');
  }
  override async createOrder(input: CreateOrderInput): Promise<CreatedOrder> {
    this.createCalls += 1;
    this.createInputs.push(input);
    return this.order;
  }
  override async getOrder(): Promise<never> {
    throw new Error('getOrder must not be called during order creation');
  }
  override async captureOrder(): Promise<never> {
    this.captureCalls += 1;
    throw new Error('captureOrder must not be called during order creation');
  }
}

const fakeOrder: CreatedOrder = {
  id: 'O-SANDBOX-1',
  status: 'CREATED',
  approveUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=O-SANDBOX-1',
  rawLinks: [],
};

function makeIntent(overrides: Partial<StructuredIntent> = {}): StructuredIntent {
  return {
    purpose: 'running shoes',
    maxAmount: 150,
    currency: 'USD',
    brands: ['Nike', 'Adidas'],
    condition: 'new',
    requiresConfirmationAbove: 100,
    constraints: [],
    ...overrides,
  };
}

function channel3Product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'channel3:runfalcon',
    source: 'channel3',
    name: 'Runfalcon 3.0 Running Shoes',
    description: 'Lightweight running shoes.',
    price: 44.95,
    currency: 'USD',
    brand: 'adidas',
    condition: 'new',
    category: 'Running Shoes',
    merchant: 'shoebacca.com',
    productUrl: 'https://shoebacca.com/p/runfalcon-3',
    availability: 'InStock',
    externalId: '1FesGXD',
    ...overrides,
  };
}

function setup(params: { intent: StructuredIntent | null; resolution: ProductResolution }) {
  const repo = new InMemoryEvidenceRepository();
  const paypal = new StubPayPalClient(fakeOrder);
  const persisted: PersistedOrder[] = [];
  const resolveCalls: Array<{ intentId: string; productId: string }> = [];

  const service = new OrderCreationService({
    policyEngine: new PolicyEngine(),
    paypal,
    evidence: new EvidenceService(repo),
    getIntent: async () => params.intent,
    resolveProduct: async (intentId, _intent, productId) => {
      resolveCalls.push({ intentId, productId });
      return params.resolution;
    },
    persistOrder: async (order) => { persisted.push(order); },
    returnUrl: 'https://example.test/return',
    cancelUrl: 'https://example.test/cancel',
  });

  return { service, repo, paypal, persisted, resolveCalls };
}

describe('OrderCreationService', () => {
  it('1. resolves a valid Channel3 product and creates a PAYMENT_PENDING order', async () => {
    const product = channel3Product();
    const { service, paypal, persisted } = setup({
      intent: makeIntent(),
      resolution: { kind: 'RESOLVED', product },
    });

    const outcome = await service.createOrder({ intentId: 'i1', productId: product.id });

    expect(outcome.kind).toBe('ORDER_CREATED');
    if (outcome.kind === 'ORDER_CREATED') {
      expect(outcome.order.id).toBe('O-SANDBOX-1');
      expect(outcome.transactionId).toBeTruthy();
      expect(outcome.confirmationRequired).toBe(false);
      // The CURRENCY rule added on the payment path is exercised and passes.
      const currencyRule = outcome.evaluation.ruleResults.find((r) => r.rule === 'CURRENCY');
      expect(currencyRule?.passed).toBe(true);
    }

    expect(paypal.createCalls).toBe(1);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].productId).toBe('channel3:runfalcon');
    expect(persisted[0].amount).toBe(44.95);
    expect(persisted[0].currency).toBe('USD');
    expect(persisted[0].paypalOrderId).toBe('O-SANDBOX-1');
  });

  it('2. rejects an unknown product id and creates no order', async () => {
    const { service, paypal, persisted } = setup({
      intent: makeIntent(),
      resolution: { kind: 'NOT_FOUND' },
    });

    const outcome = await service.createOrder({ intentId: 'i1', productId: 'channel3:missing' });

    expect(outcome).toEqual({ kind: 'PRODUCT_NOT_RESOLVED', reason: 'NOT_FOUND' });
    expect(paypal.createCalls).toBe(0);
    expect(persisted).toHaveLength(0);
  });

  it('3. surfaces stale, unusable, and wrong-intent resolutions distinctly', async () => {
    for (const reason of ['STALE', 'UNUSABLE', 'NOT_FOR_INTENT'] as const) {
      const { service, paypal, persisted } = setup({
        intent: makeIntent(),
        resolution: { kind: reason } as ProductResolution,
      });
      const outcome = await service.createOrder({ intentId: 'i1', productId: 'channel3:runfalcon' });
      expect(outcome).toEqual({ kind: 'PRODUCT_NOT_RESOLVED', reason });
      expect(paypal.createCalls).toBe(0);
      expect(persisted).toHaveLength(0);
    }
  });

  it('4. returns INTENT_NOT_FOUND without resolving or creating an order', async () => {
    const { service, paypal, persisted, resolveCalls } = setup({
      intent: null,
      resolution: { kind: 'RESOLVED', product: channel3Product() },
    });

    const outcome = await service.createOrder({ intentId: 'missing-intent', productId: 'channel3:runfalcon' });

    expect(outcome.kind).toBe('INTENT_NOT_FOUND');
    expect(resolveCalls).toHaveLength(0);
    expect(paypal.createCalls).toBe(0);
    expect(persisted).toHaveLength(0);
  });

  it('5. client-supplied price and currency cannot override the resolved offer', async () => {
    const product = channel3Product({ price: 44.95, currency: 'USD' });
    const { service, paypal, persisted } = setup({
      intent: makeIntent(),
      resolution: { kind: 'RESOLVED', product },
    });

    // A malicious/naive client may include price/currency; they are ignored.
    const clientPayload = { intentId: 'i1', productId: product.id, price: 0.01, currency: 'XYZ' };
    const outcome = await service.createOrder(clientPayload);

    expect(outcome.kind).toBe('ORDER_CREATED');
    expect(persisted[0].amount).toBe(44.95);
    expect(persisted[0].currency).toBe('USD');
    expect(paypal.createInputs[0].amount).toBe(44.95);
    expect(paypal.createInputs[0].currency).toBe('USD');
  });

  it('6. rejects a currency mismatch before any PayPal order is created', async () => {
    const product = channel3Product({ currency: 'EUR' });
    const { service, paypal, persisted } = setup({
      intent: makeIntent({ currency: 'USD' }),
      resolution: { kind: 'RESOLVED', product },
    });

    const outcome = await service.createOrder({ intentId: 'i1', productId: product.id });

    expect(outcome.kind).toBe('POLICY_DENIED');
    if (outcome.kind === 'POLICY_DENIED') {
      const currencyRule = outcome.evaluation.ruleResults.find((r) => r.rule === 'CURRENCY');
      expect(currencyRule?.passed).toBe(false);
      expect(currencyRule?.reason).toBe('CURRENCY_MISMATCH');
    }
    expect(paypal.createCalls).toBe(0);
    expect(persisted).toHaveLength(0);
  });

  it('7. rejects a resolved product that no longer satisfies the policy', async () => {
    const product = channel3Product({ price: 99 });
    const { service, paypal, persisted } = setup({
      // Same intent id, but a stricter cap than the product satisfies.
      intent: makeIntent({ maxAmount: 50 }),
      resolution: { kind: 'RESOLVED', product },
    });

    const outcome = await service.createOrder({ intentId: 'i1', productId: product.id });

    expect(outcome.kind).toBe('POLICY_DENIED');
    if (outcome.kind === 'POLICY_DENIED') {
      expect(outcome.evaluation.result).toBe('DENY');
      expect(outcome.evaluation.ruleResults.find((r) => r.rule === 'PRICE')?.passed).toBe(false);
    }
    expect(paypal.createCalls).toBe(0);
    expect(persisted).toHaveLength(0);
  });

  it('8. requires confirmation above the threshold, then creates the order when approved', async () => {
    const product = channel3Product({ price: 129 });
    const { service, paypal, persisted } = setup({
      intent: makeIntent({ requiresConfirmationAbove: 100 }),
      resolution: { kind: 'RESOLVED', product },
    });

    const blocked = await service.createOrder({ intentId: 'i1', productId: product.id });
    expect(blocked.kind).toBe('CONFIRMATION_REQUIRED');
    expect(paypal.createCalls).toBe(0);
    expect(persisted).toHaveLength(0);

    const approved = await service.createOrder({
      intentId: 'i1',
      productId: product.id,
      confirmationApproved: true,
    });
    expect(approved.kind).toBe('ORDER_CREATED');
    expect(paypal.createCalls).toBe(1);
    expect(persisted).toHaveLength(1);
  });

  it('12. never treats a retailer product URL as proof of a completed purchase', async () => {
    const product = channel3Product({ productUrl: 'https://shoebacca.com/p/runfalcon-3' });
    const { service, paypal, repo } = setup({
      intent: makeIntent(),
      resolution: { kind: 'RESOLVED', product },
    });

    const outcome = await service.createOrder({ intentId: 'i1', productId: product.id });
    expect(outcome.kind).toBe('ORDER_CREATED');

    // No capture, and no evidence event claims the payment is complete.
    expect(paypal.captureCalls).toBe(0);
    const records = await repo.getAll();
    const events = records.map((r) => r.eventType);
    expect(events).not.toContain('PAYMENT_COMPLETED');
    expect(events).not.toContain('PAYMENT_CAPTURED');
    expect(events).not.toContain('PAYPAL_PAYMENT_CAPTURED');
    expect(JSON.stringify(records)).not.toContain('shoebacca.com/p');
  });
});
