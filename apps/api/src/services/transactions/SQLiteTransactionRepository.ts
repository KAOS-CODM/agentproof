import type { Transaction } from '@agentproof/shared';
import type {
  CompletePaymentResult,
  CompletePaymentUpdate,
  PersistedTransaction,
  TransactionRepository,
} from './TransactionRepository.js';

type SqlJsDatabase = InstanceType<Awaited<ReturnType<typeof import('sql.js')>>['Database']>;

interface TransactionRow {
  id: string;
  intent_id: string;
  product_id: string;
  policy_evaluation_id: string;
  paypal_order_id: string | null;
  paypal_capture_id: string | null;
  amount: number;
  currency: string;
  financial_state: string;
  created_at: string;
  updated_at: string;
}

const SELECT_COLUMNS = `id, intent_id, product_id, policy_evaluation_id, paypal_order_id,
  paypal_capture_id, amount, currency, financial_state, created_at, updated_at`;

function rowToTransaction(row: TransactionRow): Transaction {
  return {
    id: row.id,
    intentId: row.intent_id,
    productId: row.product_id,
    policyEvaluationId: row.policy_evaluation_id,
    paypalOrderId: row.paypal_order_id,
    paypalCaptureId: row.paypal_capture_id,
    amount: row.amount,
    currency: row.currency,
    financialState: row.financial_state as Transaction['financialState'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * sql.js-backed implementation of the transaction repository, using the
 * existing `transactions` table and its existing columns. No schema change and
 * no serialization change: ids, timestamps, and column layout are unchanged.
 *
 * The completion transition is a single conditional UPDATE gated on the current
 * financial state. `getRowsModified()` distinguishes a real transition from a
 * lost race; the affected row is then re-read so the caller receives the
 * authoritative post-transition state.
 *
 * Internally synchronous (sql.js runs in-process); the Promise-based contract
 * allows an asynchronous MongoDB adapter later without changing callers.
 */
export class SQLiteTransactionRepository implements TransactionRepository {
  constructor(private readonly db: SqlJsDatabase) {}

  async insertPending(transaction: PersistedTransaction): Promise<void> {
    // Unconditional INSERT: a duplicate id raises (PRIMARY KEY) and propagates,
    // rather than being silently swallowed by INSERT OR REPLACE.
    this.db.run(
      `INSERT INTO transactions (id, user_id, intent_id, product_id, policy_evaluation_id, paypal_order_id, paypal_capture_id, amount, currency, financial_state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        transaction.id,
        transaction.userId ?? null,
        transaction.intentId,
        transaction.productId,
        transaction.policyEvaluationId,
        transaction.paypalOrderId,
        transaction.paypalCaptureId,
        transaction.amount,
        transaction.currency,
        transaction.financialState,
        transaction.createdAt,
        transaction.updatedAt,
      ],
    );
  }

  async getById(id: string): Promise<Transaction | null> {
    return this.selectOne('id = ?', [id]);
  }

  async getByIdForUser(id: string, userId: string): Promise<Transaction | null> {
    return this.selectOne('id = ? AND user_id = ?', [id, userId]);
  }

  async getByPaypalOrderId(paypalOrderId: string): Promise<Transaction | null> {
    return this.selectOne('paypal_order_id = ?', [paypalOrderId]);
  }

  async getByPaypalOrderIdForUser(
    paypalOrderId: string,
    userId: string,
  ): Promise<Transaction | null> {
    return this.selectOne('paypal_order_id = ? AND user_id = ?', [paypalOrderId, userId]);
  }

  async listForUser(
    userId: string,
    limit: number,
    intentId?: string,
  ): Promise<Transaction[]> {
    const clauses = ['user_id = ?'];
    const values: Array<string | number> = [userId];
    if (intentId !== undefined) {
      clauses.push('intent_id = ?');
      values.push(intentId);
    }
    values.push(limit);

    const stmt = this.db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM transactions
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    );
    stmt.bind(values);
    const transactions: Transaction[] = [];
    while (stmt.step()) {
      transactions.push(
        rowToTransaction(stmt.getAsObject() as unknown as TransactionRow),
      );
    }
    stmt.free();
    return transactions;
  }

  async completePayment(update: CompletePaymentUpdate): Promise<CompletePaymentResult> {
    // Compare-and-set: the row only changes while it is still PAYMENT_PENDING,
    // so exactly one competing request can win the transition. Supplying an owner
    // additionally prevents a guessed id from transitioning another user's row.
    const ownerClause = update.userId ? ' AND user_id = ?' : '';
    const values: Array<string | null> = [
      'PAYMENT_COMPLETED',
      update.paypalCaptureId,
      update.updatedAt,
      update.transactionId,
      'PAYMENT_PENDING',
    ];
    if (update.userId) values.push(update.userId);
    this.db.run(
      `UPDATE transactions SET financial_state = ?, paypal_capture_id = ?, updated_at = ? WHERE id = ? AND financial_state = ?${ownerClause}`,
      values,
    );

    const transaction = update.userId
      ? await this.getByIdForUser(update.transactionId, update.userId)
      : await this.getById(update.transactionId);
    if (!transaction) {
      return { kind: 'NOT_FOUND' };
    }
    if (this.db.getRowsModified() === 0) {
      // The row exists but was not PAYMENT_PENDING: another request won.
      return { kind: 'NOT_PENDING', transaction };
    }
    return { kind: 'TRANSITIONED', transaction };
  }

  private selectOne(where: string, values: string[]): Transaction | null {
    const stmt = this.db.prepare(`SELECT ${SELECT_COLUMNS} FROM transactions WHERE ${where}`);
    stmt.bind(values);
    let row: TransactionRow | null = null;
    if (stmt.step()) {
      row = stmt.getAsObject() as unknown as TransactionRow;
    }
    stmt.free();
    return row ? rowToTransaction(row) : null;
  }
}
