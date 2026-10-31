import type {
  PersistedSelection,
  Selection,
  SelectionRepository,
  SelectOutcome,
} from './SelectionRepository.js';
import {
  assertNewSelection,
  assertSelectionRecord,
} from './SelectionRepository.js';

type SqlJsDatabase = InstanceType<Awaited<ReturnType<typeof import('sql.js')>>['Database']>;

interface SelectionRow {
  id: string;
  user_id: string;
  intent_id: string;
  snapshot_id: string;
  source: string;
  product_id: string;
  price: number;
  currency: string;
  is_active: number;
  selected_at: string;
  superseded_at: string | null;
}

const SELECT_COLUMNS = `id, user_id, intent_id, snapshot_id, source, product_id, price,
  currency, is_active, selected_at, superseded_at`;

function rowToSelection(row: SelectionRow): Selection {
  return {
    id: row.id,
    userId: row.user_id,
    intentId: row.intent_id,
    snapshotId: row.snapshot_id,
    source: row.source as Selection['source'],
    productId: row.product_id,
    price: row.price,
    currency: row.currency,
    // The column is INTEGER 0/1; never trust a truthy coercion for the flag that
    // participates in the uniqueness rule.
    isActive: row.is_active === 1,
    selectedAt: row.selected_at,
    supersededAt: row.superseded_at,
  };
}

/**
 * sql.js-backed selection repository.
 *
 * The one-active-selection rule is enforced by the `uniq_active_selection`
 * partial unique index created in the P1 migration
 * (`intent_id WHERE is_active = 1`), not by the adapter's own bookkeeping. The
 * adapter's job is only to order its two writes so that the index is never
 * violated:
 *
 *   1. supersede the current active row (`is_active = 0`, stamp
 *      `superseded_at`) — history preserved in place, never deleted;
 *   2. insert the new active row.
 *
 * Ordering is deliberate. Inserting first would briefly require two active rows
 * for the same intent and would be rejected by the index; superseding first
 * means a crash between the two statements leaves *no* active selection, which
 * fails closed (order creation refuses to proceed) instead of leaving two
 * competing selections.
 *
 * sql.js is single-threaded (`THREADSAFE=0`) and this adapter issues no `await`
 * between the two statements, so nothing can interleave inside `select()` in
 * this process. The duplicate handling below is therefore a backstop that keeps
 * the observable outcome identical to the MongoDB adapter rather than a path
 * exercised in normal operation.
 */
export class SQLiteSelectionRepository implements SelectionRepository {
  constructor(private readonly db: SqlJsDatabase) {}

  async select(selection: PersistedSelection): Promise<SelectOutcome> {
    assertSelectionRecord(selection);
    assertNewSelection(selection);

    const current = this.selectActive(selection.intentId, selection.userId);
    if (current && current.snapshotId === selection.snapshotId) {
      // Re-selecting the offer that is already active is a no-op: the original
      // row keeps its id and selectedAt, and no duplicate history is appended.
      return { kind: 'ALREADY_ACTIVE', selection: current };
    }

    // Checked before the supersede so a duplicate id fails without leaving the
    // intent with no active selection as a side effect.
    if (this.existsById(selection.id)) {
      throw new Error(`Selection ${selection.id} already exists`);
    }

    this.db.run(
      `UPDATE intent_selections
          SET is_active = 0, superseded_at = ?
        WHERE intent_id = ? AND user_id = ? AND is_active = 1`,
      [selection.selectedAt, selection.intentId, selection.userId],
    );

    try {
      this.db.run(
        `INSERT INTO intent_selections
           (id, user_id, intent_id, snapshot_id, source, product_id, price, currency,
            is_active, selected_at, superseded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL)`,
        [
          selection.id,
          selection.userId,
          selection.intentId,
          selection.snapshotId,
          selection.source,
          selection.productId,
          selection.price,
          selection.currency,
          selection.selectedAt,
        ],
      );
    } catch (err) {
      // A duplicate primary key is a caller bug, not a lost race: re-throw it.
      if (this.existsById(selection.id)) throw err;

      const winner = this.selectActive(selection.intentId, selection.userId);
      if (!winner) throw err;
      return winner.snapshotId === selection.snapshotId
        ? { kind: 'ALREADY_ACTIVE', selection: winner }
        : { kind: 'CONFLICT', selection: winner };
    }

    return {
      kind: 'ACTIVATED',
      selection: {
        ...selection,
        isActive: true,
        supersededAt: null,
      },
    };
  }

  async getActive(intentId: string, userId: string): Promise<Selection | null> {
    return this.selectActive(intentId, userId);
  }

  async listHistory(intentId: string, userId: string): Promise<Selection[]> {
    const stmt = this.db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM intent_selections
        WHERE intent_id = ? AND user_id = ?
        ORDER BY selected_at DESC, id DESC`,
    );
    stmt.bind([intentId, userId]);
    const selections: Selection[] = [];
    while (stmt.step()) {
      selections.push(rowToSelection(stmt.getAsObject() as unknown as SelectionRow));
    }
    stmt.free();
    return selections;
  }

  private selectActive(intentId: string, userId: string): Selection | null {
    const stmt = this.db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM intent_selections
        WHERE intent_id = ? AND user_id = ? AND is_active = 1
        LIMIT 1`,
    );
    stmt.bind([intentId, userId]);
    let row: SelectionRow | null = null;
    if (stmt.step()) {
      row = stmt.getAsObject() as unknown as SelectionRow;
    }
    stmt.free();
    return row ? rowToSelection(row) : null;
  }

  private existsById(id: string): boolean {
    const stmt = this.db.prepare('SELECT 1 FROM intent_selections WHERE id = ? LIMIT 1');
    stmt.bind([id]);
    const found = stmt.step();
    stmt.free();
    return found;
  }
}
