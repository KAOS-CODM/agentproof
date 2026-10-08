import { describe, it, expect } from 'vitest';
import type { EvidenceRecord, StructuredIntent } from '@agentproof/shared';
import { PaymentService } from './PaymentService.js';
import { PolicyEngine } from '../policy/PolicyEngine.js';
import { EvidenceService } from '../evidence/EvidenceService.js';
import type { EvidenceRepository } from '../evidence/EvidenceRepository.js';
import { PayPalClient, type CreatedOrder } from './PayPalClient.js';
import { DEMO_PRODUCTS } from '../discovery/DemoCatalogService.js';

class InMemoryEvidenceRepository implements EvidenceRepository {
  records: EvidenceRecord[] = [];
  append(r: EvidenceRecord) { this.records.push(r); }
  getById(id: string) { return this.records.find((r) => r.id === id) ?? null; }
  getByIntentId(intentId: string) { return this.records.filter((r) => r.intentId === intentId); }
  getByTransactionId(txId: string) { return this.records.filter((r) => r.transactionId === txId); }
  getAll() { return [...this.records]; }
}

const intent: StructuredIntent = {
  purpose: 'running shoes',
  maxAmount: 150,
  currency: 'USD',
  brands: ['Nike', 'Adidas'],
  condition: 'new',
  requiresConfirmationAbove: 100,
  constraints: [],
};

const pegasus = DEMO_PRODUCTS.find((p) => p.id === 'demo-nike-pegasus-100')!;  // $99, new, Nike
const ultraboost = DEMO_PRODUCTS.find((p) => p.id === 'demo-adidas-ultraboost-129')!; // $129 → confirmation
const vaporfly = DEMO_PRODUCTS.find((p) => p.id === 'demo-nike-vaporfly-179')!; // $179 → DENY

class StubPayPalClient extends PayPalClient {
  calls = 0;
  constructor(private readonly order: CreatedOrder) { super('x', 'y', 'https://api-m.sandbox.paypal.com'); }
  override async createOrder(): Promise<CreatedOrder> {
    this.calls += 1;
    return this.order;
  }
}

const fakeOrder: CreatedOrder = { id: 'O-SANDBOX-1', status: 'CREATED', approveUrl: 'https://paypal.com/x', rawLinks: [] };

describe('PaymentService', () => {
  it('9. successful order creation records PAYPAL_ORDER_CREATED with provenance, no secrets', async () => {
    const repo = new InMemoryEvidenceRepository();
    const paypal = new StubPayPalClient(fakeOrder);
    const svc = new PaymentService({ policyEngine: new PolicyEngine(), evidence: new EvidenceService(repo), paypal });

    const result = await svc.createOrder({ intentId: 'i1', intent, product: pegasus });

    expect(result.kind).toBe('ORDER_CREATED');
    const ev = repo.getAll().find((r) => r.eventType === 'PAYPAL_ORDER_CREATED');
    expect(ev).toBeDefined();
    expect(ev!.metadata.source).toBe('paypal_api');
    expect(ev!.actor).toBe('paypal');
    expect(ev!.data.paypalOrderId).toBe('O-SANDBOX-1');
    expect(ev!.data.productId).toBe('demo-nike-pegasus-100');
    expect(JSON.stringify(repo.getAll())).not.toContain('access_token');
  });

  it('10. successful order creation never produces PAYMENT_COMPLETED', async () => {
    const repo = new InMemoryEvidenceRepository();
    const paypal = new StubPayPalClient(fakeOrder);
    const svc = new PaymentService({ policyEngine: new PolicyEngine(), evidence: new EvidenceService(repo), paypal });

    await svc.createOrder({ intentId: 'i1', intent, product: pegasus });

    const events = repo.getAll().map((r) => r.eventType);
    expect(events).not.toContain('PAYMENT_CAPTURED');
    expect(JSON.stringify(repo.getAll())).not.toContain('PAYMENT_COMPLETED');
  });

  it('policy DENY blocks PayPal order creation', async () => {
    const repo = new InMemoryEvidenceRepository();
    const paypal = new StubPayPalClient(fakeOrder);
    const svc = new PaymentService({ policyEngine: new PolicyEngine(), evidence: new EvidenceService(repo), paypal });

    const result = await svc.createOrder({ intentId: 'i1', intent, product: vaporfly });
    expect(result.kind).toBe('POLICY_DENIED');
    expect(paypal.calls).toBe(0);
  });

  it('confirmation required blocks order creation until approved', async () => {
    const repo = new InMemoryEvidenceRepository();
    const paypal = new StubPayPalClient(fakeOrder);
    const svc = new PaymentService({ policyEngine: new PolicyEngine(), evidence: new EvidenceService(repo), paypal });

    const blocked = await svc.createOrder({ intentId: 'i1', intent, product: ultraboost });
    expect(blocked.kind).toBe('CONFIRMATION_REQUIRED');
    expect(paypal.calls).toBe(0);

    const approved = await svc.createOrder({ intentId: 'i1', intent, product: ultraboost, confirmationApproved: true });
    expect(approved.kind).toBe('ORDER_CREATED');
    expect(paypal.calls).toBe(1);
  });
});
