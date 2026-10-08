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
  orderDetails: ReturnType<PayPalClient['getOrder']> extends Promise<infer T> ? T : never = {
    id: 'O-SANDBOX-1', status: 'APPROVED', intent: 'CAPTURE', invoiceId: 'i1-demo-nike-pegasus-100', amount: 99, currency: 'USD',
  };
  captureResult: ReturnType<PayPalClient['captureOrder']> extends Promise<infer T> ? T : never = {
    orderId: 'O-SANDBOX-1', orderStatus: 'COMPLETED', captureId: 'CAP-1', captureStatus: 'COMPLETED', amount: 99, currency: 'USD',
  };
  captureCalls = 0;
  constructor(private readonly order: CreatedOrder) { super('x', 'y', 'https://api-m.sandbox.paypal.com'); }
  override async createOrder(): Promise<CreatedOrder> {
    this.calls += 1;
    return this.order;
  }
  override async getOrder() { return this.orderDetails; }
  override async captureOrder() { this.captureCalls += 1; return this.captureResult; }
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

  describe('captureApprovedOrder', () => {
    const baseCaptureParams = {
      transactionId: 'tx-1',
      intentId: 'i1',
      productId: 'demo-nike-pegasus-100',
      paypalOrderId: 'O-SANDBOX-1',
      expectedAmount: 99,
      expectedCurrency: 'USD',
      financialState: 'PAYMENT_PENDING' as const,
      policyEvaluationId: 'pe-1',
    };

    function captureSetup(paypal: StubPayPalClient, repo: InMemoryEvidenceRepository, persist?: (u: never) => void) {
      return new PaymentService({
        policyEngine: new PolicyEngine(),
        evidence: new EvidenceService(repo),
        paypal,
        persistTransactionState: persist as never,
      });
    }

    it('happy path: retrieval → approval verified → capture → PAYMENT_COMPLETED with evidence', async () => {
      const repo = new InMemoryEvidenceRepository();
      const paypal = new StubPayPalClient(fakeOrder);
      paypal.orderDetails = { id: 'O-SANDBOX-1', status: 'APPROVED', intent: 'CAPTURE', invoiceId: 'i1-demo-nike-pegasus-100', amount: 99, currency: 'USD' };
      const updates: Array<{ financialState: string; paypalCaptureId: string | null }> = [];
      const svc = captureSetup(paypal, repo, (u: { financialState: string; paypalCaptureId: string | null }) => updates.push(u));

      const result = await svc.captureApprovedOrder(baseCaptureParams);

      expect(result.kind).toBe('PAYMENT_COMPLETED');
      expect(paypal.captureCalls).toBe(1);
      expect(updates.length).toBe(1);
      expect(updates[0].financialState).toBe('PAYMENT_COMPLETED');
      expect(updates[0].paypalCaptureId).toBe('CAP-1');
      const events = repo.getAll().map((r) => r.eventType);
      expect(events).toContain('PAYPAL_ORDER_APPROVAL_VERIFIED');
      expect(events).toContain('PAYPAL_PAYMENT_CAPTURED');
      expect(events).toContain('PAYMENT_CAPTURED');
      expect(events).toContain('PAYMENT_COMPLETED');
      const completed = repo.getAll().find((r) => r.eventType === 'PAYMENT_COMPLETED')!;
      expect(completed.metadata.source).toBe('paypal_api');
      expect(completed.data.paypalOrderId).toBe('O-SANDBOX-1');
      expect(JSON.stringify(repo.getAll())).not.toContain('access_token');
    });

    it('duplicate completion is idempotent — no second capture', async () => {
      const repo = new InMemoryEvidenceRepository();
      const paypal = new StubPayPalClient(fakeOrder);
      const svc = captureSetup(paypal, repo);

      const result = await svc.captureApprovedOrder({ ...baseCaptureParams, financialState: 'PAYMENT_COMPLETED' });
      expect(result.kind).toBe('ALREADY_COMPLETED');
      expect(paypal.captureCalls).toBe(0);
    });

    it('invalid PayPal order state does not produce PAYMENT_COMPLETED', async () => {
      const repo = new InMemoryEvidenceRepository();
      const paypal = new StubPayPalClient(fakeOrder);
      paypal.orderDetails = { ...paypal.orderDetails, status: 'CREATED' };
      const svc = captureSetup(paypal, repo);

      const result = await svc.captureApprovedOrder(baseCaptureParams);
      expect(result.kind).toBe('INVALID_ORDER_STATE');
      expect(paypal.captureCalls).toBe(0);
      expect(repo.getAll().map((r) => r.eventType)).not.toContain('PAYMENT_COMPLETED');
    });

    it('mismatched PayPal order fails closed', async () => {
      const repo = new InMemoryEvidenceRepository();
      const paypal = new StubPayPalClient(fakeOrder);
      paypal.orderDetails = { ...paypal.orderDetails, invoiceId: 'someone-else' };
      const svc = captureSetup(paypal, repo);

      const result = await svc.captureApprovedOrder(baseCaptureParams);
      expect(result.kind).toBe('MISMATCHED_ORDER');
      expect(paypal.captureCalls).toBe(0);
    });

    it('capture failure does not produce PAYMENT_COMPLETED', async () => {
      const repo = new InMemoryEvidenceRepository();
      const paypal = new StubPayPalClient(fakeOrder);
      paypal.captureOrder = async () => { throw new Error('PayPal 500'); };
      const svc = captureSetup(paypal, repo);

      await expect(svc.captureApprovedOrder(baseCaptureParams)).rejects.toThrow('PayPal 500');
      expect(repo.getAll().map((r) => r.eventType)).not.toContain('PAYMENT_COMPLETED');
    });

    it('reconciles when PayPal reports order COMPLETED but local state is PENDING', async () => {
      const repo = new InMemoryEvidenceRepository();
      const paypal = new StubPayPalClient(fakeOrder);
      paypal.orderDetails = { ...paypal.orderDetails, status: 'COMPLETED' };
      const svc = captureSetup(paypal, repo);

      const result = await svc.captureApprovedOrder(baseCaptureParams);
      expect(result.kind).toBe('PAYMENT_COMPLETED');
      expect(result.kind === 'PAYMENT_COMPLETED' && result.reconciled).toBe(true);
      expect(paypal.captureCalls).toBe(0);
    });

    it('invalid local financial state is rejected', async () => {
      const repo = new InMemoryEvidenceRepository();
      const paypal = new StubPayPalClient(fakeOrder);
      const svc = captureSetup(paypal, repo);

      const result = await svc.captureApprovedOrder({ ...baseCaptureParams, financialState: 'FULFILLMENT' });
      expect(result.kind).toBe('INVALID_STATE');
      expect(paypal.captureCalls).toBe(0);
    });

    it('unverified capture response fails closed', async () => {
      const repo = new InMemoryEvidenceRepository();
      const paypal = new StubPayPalClient(fakeOrder);
      paypal.captureResult = { orderId: 'O-SANDBOX-1', orderStatus: 'COMPLETED', captureId: 'CAP-1', captureStatus: 'PENDING', amount: 99, currency: 'USD' };
      const svc = captureSetup(paypal, repo);

      const result = await svc.captureApprovedOrder(baseCaptureParams);
      expect(result.kind).toBe('CAPTURE_UNVERIFIED');
      expect(repo.getAll().map((r) => r.eventType)).not.toContain('PAYMENT_COMPLETED');
    });
  });
});
