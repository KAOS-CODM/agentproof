import type { Transaction } from '@agentproof/shared';
import type { Collection, Db } from 'mongodb';
import type {
  CompletePaymentResult,
  CompletePaymentUpdate,
  PersistedTransaction,
  TransactionRepository,
} from './TransactionRepository.js';

/**
 * MongoDB-backed implementation of the transaction repository.
 *
 * Document contract (`transactions`):
 *   { _id: string, intentId: string, productId: string,
 *     policyEvaluationId: string, amount: number, currency: string,
 *     financialState: string, createdAt: Date, updatedAt: Date,
 *     paypalOrderId?: string, paypalCaptureId?: string }
 *
 * The optional PayPal identifiers are OMITTED until they exist (never stored as
 * explicit `null`). Combined with the partial unique index on string-valued
 * `paypalOrderId`, this lets many pending transactions coexist without an order
 * id while still preventing one real order id from being assigned twice. On read,
 * an absent field maps back to `null` to match the domain `Transaction` type.
 *
 * The completion transition is a single-document conditional atomic update
 * (`updateOne` gated on `financialState: 'PAYMENT_PENDING'`), the MongoDB
 * equivalent of the SQLite CAS `UPDATE ... WHERE id = ? AND financial_state =
 * 'PAYMENT_PENDING'`. `matchedCount === 1` ⇒ TRANSITIONED; `0` with the document
 * present ⇒ NOT_PENDING; absent ⇒ NOT_FOUND. A driver error rejects and is never
 * reported as a missing row or a successful transition.
 */

interface TransactionDoc {
  _id: string;
  userId?: string;
  intentId: string;
  productId: string;
  policyEvaluationId: string;
  amount: number;
  currency: string;
  financialState: Transaction['financialState'];
  createdAt: Date;
  updatedAt: Date;
  paypalOrderId?: string;
  paypalCaptureId?: string;
}

function toTransaction(doc: TransactionDoc): Transaction {
  return {
    id: doc._id,
    intentId: doc.intentId,
    productId: doc.productId,
    policyEvaluationId: doc.policyEvaluationId,
    paypalOrderId: doc.paypalOrderId ?? null,
    paypalCaptureId: doc.paypalCaptureId ?? null,
    amount: doc.amount,
    currency: doc.currency,
    financialState: doc.financialState,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export class MongoTransactionRepository implements TransactionRepository {
  constructor(private readonly db: Db) {}

  private get collection(): Collection<TransactionDoc> {
    return this.db.collection<TransactionDoc>('transactions');
  }

  async insertPending(transaction: PersistedTransaction): Promise<void> {
    // Unconditional insert: a duplicate _id raises (E11000) and propagates,
    // rather than being silently swallowed by an upsert.
    const doc: TransactionDoc = {
      _id: transaction.id,
      intentId: transaction.intentId,
      productId: transaction.productId,
      policyEvaluationId: transaction.policyEvaluationId,
      amount: transaction.amount,
      currency: transaction.currency,
      financialState: transaction.financialState,
      createdAt: new Date(transaction.createdAt),
      updatedAt: new Date(transaction.updatedAt),
    };
    if (transaction.userId) doc.userId = transaction.userId;
    if (transaction.paypalOrderId !== null) doc.paypalOrderId = transaction.paypalOrderId;
    if (transaction.paypalCaptureId !== null) doc.paypalCaptureId = transaction.paypalCaptureId;

    await this.collection.insertOne(doc);
  }

  async getById(id: string): Promise<Transaction | null> {
    const doc = await this.collection.findOne({ _id: id });
    return doc ? toTransaction(doc) : null;
  }

  async getByIdForUser(id: string, userId: string): Promise<Transaction | null> {
    const doc = await this.collection.findOne({ _id: id, userId });
    return doc ? toTransaction(doc) : null;
  }

  async getByPaypalOrderId(paypalOrderId: string): Promise<Transaction | null> {
    const doc = await this.collection.findOne({ paypalOrderId });
    return doc ? toTransaction(doc) : null;
  }

  async getByPaypalOrderIdForUser(
    paypalOrderId: string,
    userId: string,
  ): Promise<Transaction | null> {
    const doc = await this.collection.findOne({ paypalOrderId, userId });
    return doc ? toTransaction(doc) : null;
  }

  async listForUser(
    userId: string,
    limit: number,
    intentId?: string,
  ): Promise<Transaction[]> {
    const filter: Record<string, unknown> = { userId };
    if (intentId !== undefined) filter.intentId = intentId;

    const docs = await this.collection
      .find(filter as never)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    return docs.map(toTransaction);
  }

  async completePayment(update: CompletePaymentUpdate): Promise<CompletePaymentResult> {
    // Compare-and-set: only a still-PAYMENT_PENDING document can be updated, so
    // at most one competing request wins the transition. Match SQLite behavior by
    // explicitly writing paypalCaptureId (including NULL) on reconciliation so the
    // stored document shape remains consistent across adapters.
    const set: Record<string, unknown> = {
      financialState: 'PAYMENT_COMPLETED',
      paypalCaptureId: update.paypalCaptureId ?? null,
      updatedAt: new Date(update.updatedAt),
    };

    const filter: Record<string, unknown> = {
      _id: update.transactionId,
      financialState: 'PAYMENT_PENDING',
    };
    if (update.userId) filter.userId = update.userId;

    const result = await this.collection.updateOne(
      filter as never,
      { $set: set as Partial<TransactionDoc> },
    );

    if (result.matchedCount === 1) {
      const transaction = update.userId
        ? await this.getByIdForUser(update.transactionId, update.userId)
        : await this.getById(update.transactionId);
      // The row exists and we just updated it; a concurrent delete is not part
      // of any current flow, but guard rather than fabricate a state.
      if (!transaction) return { kind: 'NOT_FOUND' };
      return { kind: 'TRANSITIONED', transaction };
    }

    // No document matched: either it is not PAYMENT_PENDING (a lost race), it is
    // owned by someone else, or it does not exist. Re-read with the same scope
    // to disambiguate — an error here rejects rather than being misreported as
    // NOT_FOUND.
    const transaction = update.userId
      ? await this.getByIdForUser(update.transactionId, update.userId)
      : await this.getById(update.transactionId);
    if (!transaction) return { kind: 'NOT_FOUND' };
    return { kind: 'NOT_PENDING', transaction };
  }
}
