import { describe, expect, it } from 'vitest';
import type { EvidenceRecord, Product, Transaction } from '@agentproof/shared';
import type { DiscoverResponse } from './api';
import {
  evidenceCompleteness,
  latestSafeTransaction,
  latestTransaction,
  mergeTransactions,
  paymentDisplay,
  pendingTransactionFromOrder,
  productForTransaction,
  safeTransactionById,
  transactionStatusLabel,
} from './workflow';

function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx-1',
    intentId: 'intent-1',
    productId: 'product-1',
    policyEvaluationId: 'pe-1',
    paypalOrderId: 'O-1',
    paypalCaptureId: null,
    amount: 99,
    currency: 'USD',
    financialState: 'PAYMENT_PENDING',
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-20T10:00:00.000Z',
    ...overrides,
  };
}

function evidence(eventType: EvidenceRecord['eventType'], id: string): EvidenceRecord {
  return {
    id,
    eventType,
    timestamp: '2026-10-20T10:00:00.000Z',
    actor: 'paypal',
    transactionId: 'tx-1',
    intentId: 'intent-1',
    approvalRequestId: null,
    policyEvaluationId: 'pe-1',
    data: {},
    metadata: { source: 'paypal_api', correlationId: 'corr-1' },
  };
}

function product(id: string): Product {
  return {
    id,
    source: 'demo_catalog',
    name: `Product ${id}`,
    description: 'Test product',
    price: 99,
    currency: 'USD',
    brand: 'Test',
    condition: 'new',
    category: 'Test',
  };
}

function discovery(allowed: Product[] = []): DiscoverResponse {
  return {
    intentId: 'intent-1',
    candidates: allowed.map((entry) => ({
      product: entry,
      evaluation: {
        id: `pe-${entry.id}`,
        intentId: 'intent-1',
        productId: entry.id,
        result: 'ALLOW',
        confirmationRequired: false,
        ruleResults: [],
        evaluatedAt: '2026-10-20T10:00:00.000Z',
      },
    })),
    allowed: [],
    rejected: [],
    aiRecommendation: null,
    finalEvaluation: null,
    selectedProduct: null,
    decision: 'ALLOW',
    confirmationRequired: false,
    failureReason: null,
  };
}

describe('persisted workflow reconstruction', () => {
  it('selects the latest transaction for the requested intent only', () => {
    const older = transaction({ id: 'old', createdAt: '2026-10-20T09:00:00.000Z' });
    const newer = transaction({ id: 'new', createdAt: '2026-10-20T11:00:00.000Z' });
    const foreign = transaction({
      id: 'foreign',
      intentId: 'intent-2',
      createdAt: '2026-10-20T12:00:00.000Z',
    });

    expect(latestTransaction([older, foreign, newer], 'intent-1')?.id).toBe('new');
    expect(latestTransaction([foreign], 'intent-1')).toBeNull();
  });

  it('merges a refreshed transaction over the stale pending row', () => {
    const pending = transaction();
    const completed = transaction({
      financialState: 'PAYMENT_COMPLETED',
      paypalCaptureId: 'CAP-1',
      updatedAt: '2026-10-20T10:05:00.000Z',
    });

    const merged = mergeTransactions([pending], [completed]);
    expect(merged).toHaveLength(1);
    expect(merged[0].financialState).toBe('PAYMENT_COMPLETED');
    expect(merged[0].paypalCaptureId).toBe('CAP-1');
    expect(merged[0].updatedAt).toBe('2026-10-20T10:05:00.000Z');
  });

  it('never regresses a confirmed payment from a late stale history response', () => {
    const completed = transaction({
      financialState: 'PAYMENT_COMPLETED',
      paypalCaptureId: 'CAP-1',
      updatedAt: '2026-10-20T10:05:00.000Z',
    });
    const stalePending = transaction({ updatedAt: '2026-10-20T10:00:00.000Z' });

    const merged = mergeTransactions([completed], [stalePending]);
    expect(merged).toHaveLength(1);
    expect(merged[0].financialState).toBe('PAYMENT_COMPLETED');
    expect(merged[0].paypalCaptureId).toBe('CAP-1');
  });

  it('uses the same monotonic merge for the panel and capture recovery', () => {
    const completed = transaction({
      financialState: 'PAYMENT_COMPLETED',
      paypalCaptureId: 'CAP-1',
      updatedAt: '2026-10-20T10:05:00.000Z',
    });
    const stalePending = transaction({ updatedAt: '2026-10-20T10:00:00.000Z' });

    expect(latestSafeTransaction(completed, [stalePending], 'intent-1')).toMatchObject({
      id: completed.id,
      financialState: 'PAYMENT_COMPLETED',
      paypalCaptureId: 'CAP-1',
    });
    expect(
      latestSafeTransaction(transaction(), [completed], 'intent-1')?.financialState,
    ).toBe('PAYMENT_COMPLETED');
    expect(latestSafeTransaction(null, [], 'intent-1')).toBeNull();
  });

  it('keeps capture recovery bound to the requested transaction', () => {
    const target = transaction({
      id: 'tx-target',
      financialState: 'PAYMENT_COMPLETED',
      paypalCaptureId: 'CAP-TARGET',
      updatedAt: '2026-10-20T10:05:00.000Z',
    });
    const other = transaction({
      id: 'tx-other',
      financialState: 'PAYMENT_COMPLETED',
      paypalCaptureId: 'CAP-OTHER',
      createdAt: '2026-10-20T12:00:00.000Z',
      updatedAt: '2026-10-20T12:05:00.000Z',
    });

    expect(safeTransactionById(target, [other], 'tx-target')).toMatchObject({
      id: 'tx-target',
      financialState: 'PAYMENT_COMPLETED',
      paypalCaptureId: 'CAP-TARGET',
    });
    expect(safeTransactionById(target, [other], 'tx-missing')).toBeNull();
    expect(safeTransactionById(null, [other], 'tx-target')).toBeNull();
  });

  it('distinguishes complete, incomplete, and not-yet-completed evidence', () => {
    const completed = transaction({
      financialState: 'PAYMENT_COMPLETED',
      paypalCaptureId: 'CAP-1',
    });
    const complete = [
      evidence('PAYPAL_PAYMENT_CAPTURED', 'ev-1'),
      evidence('PAYMENT_CAPTURED', 'ev-2'),
      evidence('PAYMENT_COMPLETED', 'ev-3'),
    ];

    expect(evidenceCompleteness(transaction(), complete)).toBeNull();
    expect(evidenceCompleteness(completed, complete)).toBe('complete');
    expect(evidenceCompleteness(completed, complete.slice(0, 2))).toBe('incomplete');
    expect(
      evidenceCompleteness(
        transaction({ financialState: 'PAYMENT_COMPLETED', paypalCaptureId: null }),
        [evidence('PAYMENT_COMPLETED', 'ev-3')],
      ),
    ).toBe('complete');
  });

  it('restores the selected product only from an allowed snapshot', () => {
    const allowed = product('allowed');
    const response = discovery([allowed]);
    const denied = {
      ...allowed,
      id: 'denied',
    };
    response.candidates.push({
      product: denied,
      evaluation: {
        ...response.candidates[0].evaluation,
        id: 'pe-denied',
        productId: 'denied',
        result: 'DENY',
      },
    });

    expect(productForTransaction(response, transaction({ productId: 'allowed' }))?.id).toBe(
      'allowed',
    );
    expect(productForTransaction(response, transaction({ productId: 'denied' }))).toBeNull();
    expect(productForTransaction(response, transaction({ productId: 'missing' }))).toBeNull();
  });

  it('maps an optimistic pending row from a created order and labels status honestly', () => {
    const selected = product('allowed');
    const pending = pendingTransactionFromOrder(
      'intent-1',
      selected,
      {
        transactionId: 'tx-1',
        financialState: 'PAYMENT_PENDING',
        paypal: { orderId: 'O-1', status: 'CREATED', approveUrl: 'https://example.test' },
        evaluation: {
          id: 'pe-1',
          intentId: 'intent-1',
          productId: 'allowed',
          result: 'ALLOW',
          confirmationRequired: false,
          ruleResults: [],
          evaluatedAt: '2026-10-20T10:00:00.000Z',
        },
        confirmationRequired: false,
      },
      '2026-10-20T10:00:00.000Z',
    );

    expect(pending).toMatchObject({
      id: 'tx-1',
      intentId: 'intent-1',
      paypalOrderId: 'O-1',
      amount: 99,
      currency: 'USD',
      financialState: 'PAYMENT_PENDING',
    });
    expect(transactionStatusLabel(pending)).toBe('Payment pending');
    expect(transactionStatusLabel(transaction({ financialState: 'PAYMENT_COMPLETED' }))).toBe('Paid');
    expect(transactionStatusLabel(null)).toBe('Intent only');
  });

  it('keeps a saved transaction amount separate from the current selection', () => {
    const selection = product('new-choice');
    selection.price = 50;
    const bought = product('bought');
    const saved = transaction({ productId: 'bought', amount: 120, currency: 'EUR' });

    expect(
      paymentDisplay({
        selectedProduct: selection,
        transactionProduct: bought,
        transaction: saved,
      }),
    ).toEqual({
      productName: 'Product bought',
      amount: 120,
      currency: 'EUR',
      fromTransaction: true,
    });
  });

  it('does not fabricate a transaction product when discovery cannot resolve it', () => {
    expect(
      paymentDisplay({
        selectedProduct: null,
        transactionProduct: null,
        transaction: transaction({ productId: 'unknown-product' }),
      }),
    ).toEqual({
      productName: 'unknown-product',
      amount: 99,
      currency: 'USD',
      fromTransaction: true,
    });
  });

  it('uses the current selection only when no transaction exists', () => {
    const selection = product('chosen');
    selection.price = 42;
    selection.currency = 'GBP';

    expect(
      paymentDisplay({
        selectedProduct: selection,
        transactionProduct: product('bought'),
        transaction: null,
      }),
    ).toEqual({
      productName: 'Product chosen',
      amount: 42,
      currency: 'GBP',
      fromTransaction: false,
    });
    expect(
      paymentDisplay({ selectedProduct: null, transactionProduct: null, transaction: null }),
    ).toBeNull();
  });

  it('shows the immutable snapshot amount instead of a later shared product price', () => {
    const shared = product('chosen');
    shared.price = 99;

    expect(
      paymentDisplay({
        selectedProduct: shared,
        selectedPrice: 44.95,
        selectedCurrency: 'USD',
        transactionProduct: null,
        transaction: null,
      }),
    ).toEqual({
      productName: 'Product chosen',
      amount: 44.95,
      currency: 'USD',
      fromTransaction: false,
    });
  });
});
