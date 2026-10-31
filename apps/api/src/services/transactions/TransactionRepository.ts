import type { FinancialState, Transaction } from '@agentproof/shared';

/**
 * A transaction to persist when a PayPal order has been created but not yet
 * captured. Mirrors the shared `Transaction` domain type; the persistence-layer
 * input is explicit so callers never invent the financial state (a new order is
 * always PAYMENT_PENDING).
 */
export interface PersistedTransaction {
  id: string;
  /** Trusted server-side owner. Ownerless legacy rows are not user-visible. */
  userId?: string | null;
  intentId: string;
  productId: string;
  policyEvaluationId: string;
  paypalOrderId: string | null;
  paypalCaptureId: string | null;
  amount: number;
  currency: string;
  financialState: FinancialState;
  createdAt: string;
  updatedAt: string;
}

/** The conditional transition applied after a verified external capture. */
export interface CompletePaymentUpdate {
  transactionId: string;
  paypalCaptureId: string | null;
  updatedAt: string;
  /** When supplied, the conditional transition only matches an owned row. */
  userId?: string | null;
}

/**
 * Outcome of a conditional completion.
 *
 *   - `TRANSITIONED` - this call won the transition from PAYMENT_PENDING to
 *     PAYMENT_COMPLETED and the returned `transaction` is the resulting row.
 *   - `NOT_PENDING`  - the transaction exists but is no longer PAYMENT_PENDING,
 *     so another request already completed it (a lost race). The caller must
 *     treat this as "already completed", never as a fresh success.
 *   - `NOT_FOUND`    - no such transaction.
 *
 * A persistence failure is NOT represented here: it surfaces as a rejected
 * Promise so a database error can never be mistaken for a successful (or a
 * lost-race) transition.
 */
export type CompletePaymentResult =
  | { kind: 'TRANSITIONED'; transaction: Transaction }
  | { kind: 'NOT_PENDING'; transaction: Transaction }
  | { kind: 'NOT_FOUND' };

/**
 * Server-side store for financial transactions.
 *
 * Transactions are the durable, server-authoritative record of payment state;
 * they are never trusted from the client. The Promise-based contract allows a
 * synchronous SQLite adapter today and an asynchronous MongoDB adapter later.
 *
 * There is deliberately no `getAll()`: transactions are always addressed by a
 * specific identifier (their own id or their PayPal order id), and an unbounded
 * scan has no current caller and would leak another party's financial records.
 */
export interface TransactionRepository {
  /**
   * Insert a newly created (PAYMENT_PENDING) transaction. A duplicate id is a
   * persistence error and surfaces as a rejected Promise rather than a silent
   * overwrite.
   */
  insertPending(transaction: PersistedTransaction): Promise<void>;

  /** Load a transaction by its id, or null when it is unknown. Internal use. */
  getById(id: string): Promise<Transaction | null>;

  /** Load a transaction only when it is owned by `userId`. */
  getByIdForUser(id: string, userId: string): Promise<Transaction | null>;

  /** Load a transaction by its PayPal order id, or null when unknown. Internal use. */
  getByPaypalOrderId(paypalOrderId: string): Promise<Transaction | null>;

  /** Load a transaction by PayPal order id only when owned by `userId`. */
  getByPaypalOrderIdForUser(
    paypalOrderId: string,
    userId: string,
  ): Promise<Transaction | null>;

  /**
   * Load a user's transactions, most recent first. An optional intent id narrows
   * the result but can never widen ownership: a foreign or unknown intent id
   * simply yields an empty list. Legacy ownerless rows are never returned.
   */
  listForUser(userId: string, limit: number, intentId?: string): Promise<Transaction[]>;

  /**
   * Conditionally move a PAYMENT_PENDING transaction to PAYMENT_COMPLETED.
   *
   * The transition must only succeed while the stored transaction is currently
   * PAYMENT_PENDING, so at most one competing request can win. Losing the race
   * is reported as `NOT_PENDING` and must NOT emit duplicate completion events.
   */
  completePayment(update: CompletePaymentUpdate): Promise<CompletePaymentResult>;
}
