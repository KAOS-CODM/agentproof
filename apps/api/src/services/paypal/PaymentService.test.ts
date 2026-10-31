import { describe, it, expect, vi } from 'vitest';
import type { StructuredIntent } from '@agentproof/shared';
import { PaymentService } from './PaymentService.js';
import { PolicyEngine } from '../policy/PolicyEngine.js';
import { EvidenceService } from '../evidence/EvidenceService.js';
import { InMemoryEvidenceRepository } from '../../test/inMemoryRepositories.js';
import { PayPalClient, type CreatedOrder } from './PayPalClient.js';
import { DEMO_PRODUCTS } from '../discovery/DemoCatalogService.js';

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
    const ev = repo.records.find((r) => r.eventType === 'PAYPAL_ORDER_CREATED');
    expect(ev).toBeDefined();
    expect(ev!.metadata.source).toBe('paypal_api');
    expect(ev!.actor).toBe('paypal');
    expect(ev!.data.paypalOrderId).toBe('O-SANDBOX-1');
    expect(ev!.data.productId).toBe('demo-nike-pegasus-100');
    expect(JSON.stringify(repo.records)).not.toContain('access_token');
  });

  it('10. successful order creation never produces PAYMENT_COMPLETED', async () => {
    const repo = new InMemoryEvidenceRepository();
    const paypal = new StubPayPalClient(fakeOrder);
    const svc = new PaymentService({ policyEngine: new PolicyEngine(), evidence: new EvidenceService(repo), paypal });

    await svc.createOrder({ intentId: 'i1', intent, product: pegasus });

    const events = repo.records.map((r) => r.eventType);
    expect(events).not.toContain('PAYMENT_CAPTURED');
    expect(JSON.stringify(repo.records)).not.toContain('PAYMENT_COMPLETED');
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

    function captureSetup(paypal: StubPayPalClient, repo: InMemoryEvidenceRepository, persist?: (u: never) => Promise<boolean>) {
      return new PaymentService({
        policyEngine: new PolicyEngine(),
        evidence: new EvidenceService(repo),
        paypal,
        persistTransactionState: persist as never,
      });
    }

    function captureSetupWithUpdates(paypal: StubPayPalClient, repo: InMemoryEvidenceRepository, updates: Array<{ financialState: string; paypalCaptureId: string | null }>) {
      return captureSetup(paypal, repo, async (u: { financialState: string; paypalCaptureId: string | null }) => {
        updates.push(u);
        return true;
      });
    }

    it('happy path: retrieval → approval verified → capture → PAYMENT_COMPLETED with evidence', async () => {
      const repo = new InMemoryEvidenceRepository();
      const paypal = new StubPayPalClient(fakeOrder);
      paypal.orderDetails = { id: 'O-SANDBOX-1', status: 'APPROVED', intent: 'CAPTURE', invoiceId: 'i1-demo-nike-pegasus-100', amount: 99, currency: 'USD' };
      const updates: Array<{ financialState: string; paypalCaptureId: string | null }> = [];
      const svc = captureSetupWithUpdates(paypal, repo, updates);

      const result = await svc.captureApprovedOrder(baseCaptureParams);

      expect(result.kind).toBe('PAYMENT_COMPLETED');
      expect(paypal.captureCalls).toBe(1);
      expect(updates.length).toBe(1);
      expect(updates[0].financialState).toBe('PAYMENT_COMPLETED');
      expect(updates[0].paypalCaptureId).toBe('CAP-1');
      const events = repo.records.map((r) => r.eventType);
      expect(events).toContain('PAYPAL_ORDER_APPROVAL_VERIFIED');
      expect(events).toContain('PAYPAL_PAYMENT_CAPTURED');
      expect(events).toContain('PAYMENT_CAPTURED');
      expect(events).toContain('PAYMENT_COMPLETED');
      const completed = repo.records.find((r) => r.eventType === 'PAYMENT_COMPLETED')!;
      expect(completed.metadata.source).toBe('paypal_api');
      expect(completed.data.paypalOrderId).toBe('O-SANDBOX-1');
      expect(JSON.stringify(repo.records)).not.toContain('access_token');
    });

    it('uses deterministic completion-evidence IDs and never overwrites an existing one', async () => {
      const repo = new InMemoryEvidenceRepository();
      const paypal = new StubPayPalClient(fakeOrder);
      paypal.orderDetails = { id: 'O-SANDBOX-1', status: 'APPROVED', intent: 'CAPTURE', invoiceId: 'i1-demo-nike-pegasus-100', amount: 99, currency: 'USD' };

      // A previous attempt already persisted the completion event.
      await repo.append({
        id: 'ev:tx-1:PAYMENT_COMPLETED',
        eventType: 'PAYMENT_COMPLETED',
        timestamp: '2026-10-20T10:00:00.000Z',
        actor: 'agent',
        transactionId: 'tx-1',
        intentId: 'i1',
        approvalRequestId: null,
        policyEvaluationId: 'pe-1',
        data: { reason: 'original' },
        metadata: { source: 'paypal_api', correlationId: 'c-original' },
      });

      const svc = captureSetup(paypal, repo);
      const result = await svc.captureApprovedOrder(baseCaptureParams);
      expect(result.kind).toBe('PAYMENT_COMPLETED');

      const completed = repo.records.filter((r) => r.eventType === 'PAYMENT_COMPLETED');
      expect(completed).toHaveLength(1);
      expect(completed[0].data).toEqual({ reason: 'original' });
      expect(repo.records.find((r) => r.eventType === 'PAYPAL_PAYMENT_CAPTURED')!.id).toBe(
        'ev:tx-1:PAYPAL_PAYMENT_CAPTURED',
      );
      expect(repo.records.find((r) => r.eventType === 'PAYMENT_CAPTURED')!.id).toBe(
        'ev:tx-1:PAYMENT_CAPTURED',
      );
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
      expect(repo.records.map((r) => r.eventType)).not.toContain('PAYMENT_COMPLETED');
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
      expect(repo.records.map((r) => r.eventType)).not.toContain('PAYMENT_COMPLETED');
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
      expect(repo.records.map((r) => r.eventType)).not.toContain('PAYMENT_COMPLETED');
    });

    it('concurrent capture: persist returns false → ALREADY_COMPLETED, no duplicate evidence', async () => {
      const repo = new InMemoryEvidenceRepository();
      const paypal = new StubPayPalClient(fakeOrder);
      paypal.orderDetails = { id: 'O-SANDBOX-1', status: 'APPROVED', intent: 'CAPTURE', invoiceId: 'i1-demo-nike-pegasus-100', amount: 99, currency: 'USD' };
      const persist = vi.fn(async () => false);
      const svc = captureSetup(paypal, repo, persist);

      const result = await svc.captureApprovedOrder(baseCaptureParams);

      expect(result.kind).toBe('ALREADY_COMPLETED');
      expect(paypal.captureCalls).toBe(1);
      const approvalEvents = repo.records.filter((r) => r.eventType === 'PAYPAL_ORDER_APPROVAL_VERIFIED');
      expect(approvalEvents).toHaveLength(1);
      const completedEvents = repo.records.filter((r) => r.eventType === 'PAYMENT_COMPLETED');
      expect(completedEvents).toHaveLength(0);
      // A lost race must not emit the post-capture PayPal evidence either.
      expect(repo.records.map((r) => r.eventType)).not.toContain('PAYPAL_PAYMENT_CAPTURED');
      expect(repo.records.map((r) => r.eventType)).not.toContain('PAYMENT_CAPTURED');
    });

    it('repository error is not misreported as a successful completion', async () => {
      const repo = new InMemoryEvidenceRepository();
      const paypal = new StubPayPalClient(fakeOrder);
      paypal.orderDetails = { id: 'O-SANDBOX-1', status: 'APPROVED', intent: 'CAPTURE', invoiceId: 'i1-demo-nike-pegasus-100', amount: 99, currency: 'USD' };
      const persist = vi.fn(async () => { throw new Error('sqlite write failed'); });
      const svc = captureSetup(paypal, repo, persist);

      await expect(svc.captureApprovedOrder(baseCaptureParams)).rejects.toThrow('sqlite write failed');
      // Nothing was completed, and no completion evidence was emitted.
      expect(repo.records.map((r) => r.eventType)).not.toContain('PAYMENT_COMPLETED');
      expect(repo.records.map((r) => r.eventType)).not.toContain('PAYPAL_PAYMENT_CAPTURED');
    });

    it('capture verification failure never completes the transaction', async () => {
      const repo = new InMemoryEvidenceRepository();
      const paypal = new StubPayPalClient(fakeOrder);
      const persist = vi.fn(async () => true);
      const svc = captureSetup(paypal, repo, persist);
      paypal.captureResult = { orderId: 'O-SANDBOX-1', orderStatus: 'COMPLETED', captureId: 'CAP-1', captureStatus: 'PENDING', amount: 99, currency: 'USD' };

      const result = await svc.captureApprovedOrder(baseCaptureParams);

      expect(result.kind).toBe('CAPTURE_UNVERIFIED');
      expect(persist).not.toHaveBeenCalled();
      expect(repo.records.map((r) => r.eventType)).not.toContain('PAYMENT_COMPLETED');
    });

    it('evidence-write failure after a successful capture keeps the payment completed (no false capture failure)', async () => {
      const repo = new InMemoryEvidenceRepository();
      const paypal = new StubPayPalClient(fakeOrder);
      paypal.orderDetails = { id: 'O-SANDBOX-1', status: 'APPROVED', intent: 'CAPTURE', invoiceId: 'i1-demo-nike-pegasus-100', amount: 99, currency: 'USD' };
      const updates: Array<{ financialState: string; paypalCaptureId: string | null }> = [];
      const svc = captureSetupWithUpdates(paypal, repo, updates);

      // Fail only the post-capture evidence write (the idempotent path).
      const originalAppend = repo.appendIfAbsent.bind(repo);
      let failNext = false;
      repo.appendIfAbsent = async (record) => {
        if (record.eventType === 'PAYPAL_PAYMENT_CAPTURED') {
          failNext = true;
          throw new Error('evidence store unavailable');
        }
        return originalAppend(record);
      };

      const result = await svc.captureApprovedOrder(baseCaptureParams);

      // The verified capture WAS durably recorded before the evidence write.
      expect(failNext).toBe(true);
      expect(updates).toHaveLength(1);
      expect(updates[0].financialState).toBe('PAYMENT_COMPLETED');
      expect(updates[0].paypalCaptureId).toBe('CAP-1');
      expect(paypal.captureCalls).toBe(1);
      // The result is a completion (not a failure) that flags the evidence gap.
      expect(result.kind).toBe('PAYMENT_COMPLETED');
      expect(result.kind === 'PAYMENT_COMPLETED' && result.evidenceIncomplete).toBe(true);
      expect(result.kind === 'PAYMENT_COMPLETED' && result.evidenceError).toContain('evidence store unavailable');
    });

    it('recovery after an evidence-write failure fills the trail without a second capture', async () => {
      const repo = new InMemoryEvidenceRepository();
      const paypal = new StubPayPalClient(fakeOrder);
      paypal.orderDetails = { id: 'O-SANDBOX-1', status: 'APPROVED', intent: 'CAPTURE', invoiceId: 'i1-demo-nike-pegasus-100', amount: 99, currency: 'USD' };
      const evidence = new EvidenceService(repo);
      const svc = new PaymentService({
        policyEngine: new PolicyEngine(),
        evidence,
        paypal,
        persistTransactionState: async () => true,
      });

      const originalAppend = repo.appendIfAbsent.bind(repo);
      let failing = true;
      repo.appendIfAbsent = async (record) => {
        if (failing && record.eventType === 'PAYPAL_PAYMENT_CAPTURED') {
          throw new Error('evidence store unavailable');
        }
        return originalAppend(record);
      };

      const result = await svc.captureApprovedOrder(baseCaptureParams);
      expect(result.kind).toBe('PAYMENT_COMPLETED');
      expect(result.kind === 'PAYMENT_COMPLETED' && result.evidenceIncomplete).toBe(true);
      expect(paypal.captureCalls).toBe(1);

      failing = false;
      const recovery = await evidence.recoverCompletionEvidence({
        transactionId: 'tx-1',
        intentId: 'i1',
        orderId: 'O-SANDBOX-1',
        policyEvaluationId: 'pe-1',
        captureId: 'CAP-1',
        amount: 99,
        currency: 'USD',
      });

      expect(recovery.failed).toEqual([]);
      expect(recovery.recovered).toEqual(
        expect.arrayContaining(['PAYPAL_PAYMENT_CAPTURED', 'PAYMENT_CAPTURED', 'PAYMENT_COMPLETED']),
      );
      // The payment stayed completed and PayPal was never called again.
      expect(paypal.captureCalls).toBe(1);
      const events = repo.records.map((r) => r.eventType);
      expect(events.filter((e) => e === 'PAYPAL_PAYMENT_CAPTURED')).toHaveLength(1);
      expect(events.filter((e) => e === 'PAYMENT_CAPTURED')).toHaveLength(1);
      expect(events.filter((e) => e === 'PAYMENT_COMPLETED')).toHaveLength(1);
    });

    it('retrying after an evidence-write failure does not issue a second PayPal capture', async () => {
      const repo = new InMemoryEvidenceRepository();
      const paypal = new StubPayPalClient(fakeOrder);
      paypal.orderDetails = { id: 'O-SANDBOX-1', status: 'APPROVED', intent: 'CAPTURE', invoiceId: 'i1-demo-nike-pegasus-100', amount: 99, currency: 'USD' };
      const completed = new Set<string>();
      const persist = vi.fn(async (u: { transactionId: string }) => {
        if (completed.has(u.transactionId)) return false;
        completed.add(u.transactionId);
        return true;
      });
      const svc = captureSetup(paypal, repo, persist as never);

      const originalAppend = repo.appendIfAbsent.bind(repo);
      repo.appendIfAbsent = async (record) => {
        if (record.eventType === 'PAYPAL_PAYMENT_CAPTURED') throw new Error('evidence store unavailable');
        return originalAppend(record);
      };

      const first = await svc.captureApprovedOrder(baseCaptureParams);
      expect(first.kind).toBe('PAYMENT_COMPLETED');
      expect(paypal.captureCalls).toBe(1);

      // A retry now sees the transaction already completed: a lost race, so it
      // must not capture again nor emit duplicate completion evidence.
      const retry = await svc.captureApprovedOrder({ ...baseCaptureParams, financialState: 'PAYMENT_COMPLETED' });
      expect(retry.kind).toBe('ALREADY_COMPLETED');
      expect(paypal.captureCalls).toBe(1);
    });
  });
});
