import type { EvidenceRecord, Product, Transaction } from '@agentproof/shared';
import type { CreateOrderResponse, DiscoverResponse } from './api';

export type EvidenceCompleteness = 'complete' | 'incomplete' | null;

/** Return the newest transaction for an intent, defensively sorting client-side. */
export function latestTransaction(
  transactions: Transaction[],
  intentId: string,
): Transaction | null {
  const matching = transactions
    .filter((transaction) => transaction.intentId === intentId)
    .slice()
    .sort((a, b) => {
      const byCreated = b.createdAt.localeCompare(a.createdAt);
      return byCreated !== 0 ? byCreated : b.updatedAt.localeCompare(a.updatedAt);
    });
  return matching[0] ?? null;
}

/** Merge history responses without duplicating a transaction already displayed. */
export function mergeTransactions(
  existing: Transaction[],
  incoming: Transaction[],
): Transaction[] {
  const byId = new Map<string, Transaction>();
  for (const transaction of existing) byId.set(transaction.id, transaction);
  for (const transaction of incoming) {
    const previous = byId.get(transaction.id);
    if (!previous || shouldReplaceTransaction(previous, transaction)) {
      byId.set(transaction.id, transaction);
    }
  }
  return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Combine the panel's current transaction with a history response and return
 * the newest safe row. This is the same monotonic merge used for global history,
 * applied to the panel so a late pending response cannot regress a completed
 * payment that is already displayed.
 */
export function latestSafeTransaction(
  current: Transaction | null,
  incoming: Transaction[],
  intentId: string,
): Transaction | null {
  return latestTransaction(mergeTransactions(current ? [current] : [], incoming), intentId);
}

/**
 * Merge a history response with the panel's current row, then return one exact
 * transaction by id. Capture recovery uses this so a different transaction for
 * the same intent can never be reported as the capture result.
 */
export function safeTransactionById(
  current: Transaction | null,
  incoming: Transaction[],
  transactionId: string,
): Transaction | null {
  return (
    mergeTransactions(current ? [current] : [], incoming).find(
      (transaction) => transaction.id === transactionId,
    ) ?? null
  );
}

/**
 * Choose the freshest row without allowing a late, stale response to regress a
 * confirmed payment back to pending. The backend state machine is the source of
 * truth; this only protects the client from out-of-order reads.
 */
function shouldReplaceTransaction(previous: Transaction, incoming: Transaction): boolean {
  if (
    previous.financialState === 'PAYMENT_COMPLETED' &&
    incoming.financialState !== 'PAYMENT_COMPLETED'
  ) {
    return false;
  }
  if (
    incoming.financialState === 'PAYMENT_COMPLETED' &&
    previous.financialState !== 'PAYMENT_COMPLETED'
  ) {
    return true;
  }
  const byUpdated = incoming.updatedAt.localeCompare(previous.updatedAt);
  if (byUpdated !== 0) return byUpdated > 0;
  return incoming.createdAt.localeCompare(previous.createdAt) >= 0;
}

/**
 * Determine whether the expected completion evidence is present for a completed
 * transaction. A completed transaction is never treated as failed just because
 * evidence is still reconciling.
 */
export function evidenceCompleteness(
  transaction: Transaction | null,
  evidence: EvidenceRecord[],
): EvidenceCompleteness {
  if (!transaction || transaction.financialState !== 'PAYMENT_COMPLETED') return null;

  const eventTypes = new Set(
    evidence
      .filter((record) => record.transactionId === transaction.id)
      .map((record) => record.eventType),
  );
  const expected = ['PAYMENT_COMPLETED'];
  if (transaction.paypalCaptureId) {
    expected.push('PAYPAL_PAYMENT_CAPTURED', 'PAYMENT_CAPTURED');
  }
  return expected.every((eventType) => eventTypes.has(eventType))
    ? 'complete'
    : 'incomplete';
}

/** Find the product snapshot selected by a persisted transaction. */
export function productForTransaction(
  discover: DiscoverResponse | null,
  transaction: Transaction | null,
): Product | null {
  if (!discover || !transaction) return null;
  const matches = discover.candidates.filter(
    (candidate) =>
      candidate.product.id === transaction.productId &&
      candidate.evaluation.result === 'ALLOW',
  );
  return matches.length === 1 ? matches[0].product : null;
}

export interface PaymentDisplay {
  productName: string;
  amount: number;
  currency: string;
  /** True when these values come from the saved transaction, not the selection. */
  fromTransaction: boolean;
}

/**
 * Values for the payment panel.
 *
 * A saved transaction owns its product, amount, and currency. The current offer
 * selection must never rewrite them, so a pending transaction keeps showing
 * what was actually recorded even when the user has since selected another
 * offer. With no transaction, the current selection is the only source.
 */
export function paymentDisplay(args: {
  selectedProduct: Product | null;
  /** Immutable selection price/currency, when an offer snapshot is available. */
  selectedPrice?: number | null;
  selectedCurrency?: string | null;
  transactionProduct: Product | null;
  transaction: Transaction | null;
}): PaymentDisplay | null {
  const { selectedProduct, transactionProduct, transaction } = args;
  if (transaction) {
    return {
      productName: transactionProduct?.name ?? transaction.productId,
      amount: transaction.amount,
      currency: transaction.currency,
      fromTransaction: true,
    };
  }
  if (selectedProduct) {
    return {
      productName: selectedProduct.name,
      amount: args.selectedPrice ?? selectedProduct.price,
      currency: args.selectedCurrency ?? selectedProduct.currency,
      fromTransaction: false,
    };
  }
  return null;
}

/**
 * Optimistic pending row for immediate UI feedback after order creation. The
 * authoritative row always replaces this once `/payments/history` responds.
 */
export function pendingTransactionFromOrder(
  intentId: string,
  product: Product,
  order: CreateOrderResponse,
  now = new Date().toISOString(),
): Transaction {
  return {
    id: order.transactionId,
    intentId,
    productId: product.id,
    policyEvaluationId: order.evaluation.id,
    paypalOrderId: order.paypal.orderId,
    paypalCaptureId: null,
    amount: product.price,
    currency: product.currency,
    financialState: order.financialState,
    createdAt: now,
    updatedAt: now,
  };
}

export function transactionStatusLabel(transaction: Transaction | null): string {
  if (!transaction) return 'Intent only';
  switch (transaction.financialState) {
    case 'PAYMENT_PENDING':
      return 'Payment pending';
    case 'PAYMENT_COMPLETED':
      return 'Paid';
    default:
      return transaction.financialState
        .toLowerCase()
        .split('_')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
  }
}
