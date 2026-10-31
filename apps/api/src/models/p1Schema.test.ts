import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';
import { closeDb, getDb, initDb } from './db.js';
import { ensureIndexes } from './mongoIndexes.js';
import type { MongoDbLike } from './mongoClient.js';
import { createFakeDb } from '../test/fakeMongo.js';

/**
 * P1 acceptance: additive schema only.
 *
 * These tests cover the two things P1 is responsible for:
 *   1. the migration creates the P6 objects on a fresh store and adds the new
 *      columns to an existing pre-P6 store without touching existing rows, and
 *   2. the active-selection uniqueness rule is actually enforced by the
 *      database, with identical semantics on both persistence adapters.
 *
 * Nothing here exercises selection, approval, or order behaviour: those land in
 * later phases and no production code reads these tables yet.
 */

const require = createRequire(import.meta.url);
const tempDir = mkdtempSync(join(tmpdir(), 'agentproof-p1-'));
const testConfig = vi.hoisted(() => ({ dbPath: '', persistenceProvider: 'sqlite' }));

// Never load the repository's real .env or default database path.
vi.mock('../config/env.js', () => ({ config: testConfig }));

afterAll(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

function columnsOf(table: string): string[] {
  const result = getDb().exec(`PRAGMA table_info(${table})`);
  return (result[0]?.values ?? []).map((row) => String(row[1]));
}

function indexNames(table: string): string[] {
  const result = getDb().exec(`PRAGMA index_list(${table})`);
  return (result[0]?.values ?? []).map((row) => String(row[1]));
}

interface IndexSummary {
  name: string;
  unique: boolean;
  partial: boolean;
}

/** `PRAGMA index_list` columns: seq, name, unique, origin, partial. */
function indexSummaries(table: string): IndexSummary[] {
  const result = getDb().exec(`PRAGMA index_list(${table})`);
  return (result[0]?.values ?? []).map((row) => ({
    name: String(row[1]),
    unique: Number(row[2]) === 1,
    partial: Number(row[4]) === 1,
  }));
}

function insertSelection(params: {
  id: string;
  intentId?: string;
  isActive?: 0 | 1;
  supersededAt?: string | null;
  userId?: string;
}): void {
  getDb().run(
    `INSERT INTO intent_selections
       (id, user_id, intent_id, snapshot_id, source, product_id, price, currency,
        is_active, selected_at, superseded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      params.id,
      params.userId ?? 'user-1',
      params.intentId ?? 'intent-1',
      `snap-${params.id}`,
      'channel3',
      `product-${params.id}`,
      44.95,
      'USD',
      params.isActive ?? 1,
      '2026-01-01T00:00:00.000Z',
      params.supersededAt ?? null,
    ],
  );
}

describe('P1 fresh schema', () => {
  beforeEach(() => {
    closeDb();
    testConfig.dbPath = join(tempDir, `fresh-${randomUUID()}.db`);
  });

  it('creates the P6 tables, columns, and indexes', async () => {
    await initDb();

    for (const table of ['intent_selections', 'purchase_approvals', 'order_attempts']) {
      expect(columnsOf(table).length).toBeGreaterThan(0);
    }

    expect(columnsOf('transactions')).toEqual(
      expect.arrayContaining([
        'snapshot_id',
        'selection_id',
        'approval_id',
        'order_attempt_id',
        'product_source',
        'paypal_invoice_id',
        'authorization_fingerprint',
      ]),
    );
    expect(columnsOf('intent_offer_snapshots')).toContain('category');
    expect(columnsOf('policy_evaluations')).toEqual(
      expect.arrayContaining(['snapshot_id', 'selection_id', 'ruleset_version']),
    );

    expect(indexNames('intent_selections')).toContain('uniq_active_selection');
    expect(indexNames('order_attempts')).toContain('uniq_attempt_idempotency');
  });

  it('declares the active-selection index as unique and partial', async () => {
    await initDb();

    const index = indexSummaries('intent_selections').find(
      (entry) => entry.name === 'uniq_active_selection',
    );

    // This is the P0-1 assertion: the bundled SQLite really does support a
    // partial index, and the rule is installed rather than merely intended.
    expect(index).toBeDefined();
    expect(index!.unique).toBe(true);
    expect(index!.partial).toBe(true);
  });

  it('allows at most one active selection per intent', async () => {
    await initDb();

    insertSelection({ id: 'sel-a' });
    expect(() => insertSelection({ id: 'sel-b' })).toThrow();

    // A different intent is independent.
    insertSelection({ id: 'sel-c', intentId: 'intent-2' });
  });

  it('lets history accumulate once a selection is superseded', async () => {
    await initDb();

    insertSelection({ id: 'sel-a' });
    getDb().run(
      `UPDATE intent_selections
          SET is_active = 0, superseded_at = '2026-01-01T00:01:00.000Z'
        WHERE id = 'sel-a'`,
    );

    // The replacement becomes the one active row.
    insertSelection({ id: 'sel-b' });

    // A second superseded row for the same intent is allowed: uniqueness applies
    // only to the active row, so audit history is never constrained.
    insertSelection({
      id: 'sel-c',
      isActive: 0,
      supersededAt: '2026-01-01T00:02:00.000Z',
    });

    const active = getDb().exec(
      `SELECT COUNT(*) FROM intent_selections WHERE intent_id = 'intent-1' AND is_active = 1`,
    );
    expect(active[0]?.values[0]?.[0]).toBe(1);

    const total = getDb().exec(
      `SELECT COUNT(*) FROM intent_selections WHERE intent_id = 'intent-1'`,
    );
    expect(total[0]?.values[0]?.[0]).toBe(3);
  });

  it('refuses a row whose active flag disagrees with its superseded timestamp', async () => {
    await initDb();

    // Active but already superseded.
    expect(() => insertSelection({ id: 'bad-1', supersededAt: '2026-01-01T00:00:01.000Z' }))
      .toThrow();
    // Inactive but never superseded.
    expect(() => insertSelection({ id: 'bad-2', isActive: 0 })).toThrow();

    insertSelection({ id: 'good' });
  });

  it('rejects an unknown approval or attempt status', async () => {
    await initDb();

    const insertApproval = (id: string, status: string) =>
      getDb().run(
        `INSERT INTO purchase_approvals
           (id, user_id, intent_id, selection_id, snapshot_id, policy_evaluation_id,
            amount, currency, status, requested_at, expires_at)
         VALUES (?, 'user-1', 'intent-1', 'sel-a', 'snap-a', 'eval-1', 44.95, 'USD', ?,
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:05:00.000Z')`,
        [id, status],
      );

    expect(() => insertApproval('appr-bad', 'APPROVED')).toThrow();
    insertApproval('appr-ok', 'PENDING');
  });

  it('enforces one order attempt per idempotency key per user', async () => {
    await initDb();

    const insertAttempt = (id: string, userId: string, key: string) =>
      getDb().run(
        `INSERT INTO order_attempts
           (id, user_id, intent_id, selection_id, snapshot_id, idempotency_key,
            request_fingerprint, status, created_at, updated_at)
         VALUES (?, ?, 'intent-1', 'sel-a', 'snap-a', ?, 'fp-1', 'RESERVED', ?, ?)`,
        [
          id,
          userId,
          key,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
        ],
      );

    insertAttempt('att-1', 'user-1', 'key-1');
    expect(() => insertAttempt('att-2', 'user-1', 'key-1')).toThrow();

    // The key is scoped to the owner, so two users may use the same string.
    insertAttempt('att-3', 'user-2', 'key-1');
    insertAttempt('att-4', 'user-1', 'key-2');
  });
});

describe('P1 migration of a pre-P6 database', () => {
  const legacyPath = () => join(tempDir, 'legacy.db');

  beforeEach(() => {
    closeDb();
    testConfig.dbPath = legacyPath();
  });

  it('adds the P6 columns and tables without altering existing rows', async () => {
    const SQL = await initSqlJs({
      locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm'),
    });
    const legacy = new SQL.Database();
    legacy.exec(`
      CREATE TABLE transactions (
        id TEXT PRIMARY KEY,
        intent_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        policy_evaluation_id TEXT NOT NULL,
        paypal_order_id TEXT,
        paypal_capture_id TEXT,
        amount REAL NOT NULL,
        currency TEXT NOT NULL,
        financial_state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE policy_evaluations (
        id TEXT PRIMARY KEY,
        intent_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        result TEXT NOT NULL,
        confirmation_required INTEGER NOT NULL DEFAULT 0,
        rule_results_json TEXT NOT NULL,
        evaluated_at TEXT NOT NULL
      );
      CREATE TABLE intent_offer_snapshots (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        intent_id TEXT NOT NULL,
        source TEXT NOT NULL,
        product_id TEXT NOT NULL,
        external_product_id TEXT,
        product_name TEXT NOT NULL,
        brand TEXT,
        offer_url TEXT,
        merchant TEXT,
        price REAL NOT NULL,
        currency TEXT NOT NULL,
        availability TEXT,
        condition TEXT,
        compare_at_price REAL,
        max_commission_rate REAL,
        captured_at TEXT NOT NULL
      );

      INSERT INTO transactions
        (id, intent_id, product_id, policy_evaluation_id, paypal_order_id,
         paypal_capture_id, amount, currency, financial_state, created_at, updated_at)
        VALUES ('legacy-tx', 'legacy-intent', 'legacy-product', 'legacy-eval',
                'PAYPAL-ORDER-1', NULL, 44.95, 'USD', 'PAYMENT_PENDING',
                '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');

      INSERT INTO intent_offer_snapshots
        (id, intent_id, source, product_id, product_name, price, currency, captured_at)
        VALUES ('legacy-snap', 'legacy-intent', 'channel3', 'legacy-product',
                'Legacy Shoes', 44.95, 'USD', '2025-01-01T00:00:00.000Z');
    `);
    writeFileSync(legacyPath(), Buffer.from(legacy.export()));
    legacy.close();

    await initDb();

    expect(columnsOf('transactions')).toEqual(
      expect.arrayContaining([
        'snapshot_id',
        'selection_id',
        'approval_id',
        'order_attempt_id',
        'product_source',
        'paypal_invoice_id',
        'authorization_fingerprint',
      ]),
    );
    expect(columnsOf('intent_offer_snapshots')).toContain('category');
    expect(columnsOf('policy_evaluations')).toEqual(
      expect.arrayContaining(['snapshot_id', 'selection_id', 'ruleset_version']),
    );

    // The legacy row is preserved verbatim and is NOT given fabricated
    // bindings: every new column stays NULL so it can be classified as
    // "legacy unbound" at read time.
    const preserved = getDb().exec(
      `SELECT paypal_order_id, amount, financial_state, snapshot_id, selection_id,
              approval_id, order_attempt_id
         FROM transactions WHERE id = 'legacy-tx'`,
    );
    expect(preserved[0]?.values[0]?.[0]).toBe('PAYPAL-ORDER-1');
    expect(preserved[0]?.values[0]?.[1]).toBe(44.95);
    expect(preserved[0]?.values[0]?.[2]).toBe('PAYMENT_PENDING');
    for (const binding of preserved[0]?.values[0]?.slice(3) ?? []) {
      expect(binding).toBeNull();
    }

    // No synthetic history is invented for the legacy snapshot.
    const snapshot = getDb().exec(
      `SELECT category FROM intent_offer_snapshots WHERE id = 'legacy-snap'`,
    );
    expect(snapshot[0]?.values[0]?.[0]).toBeNull();

    for (const table of ['intent_selections', 'purchase_approvals', 'order_attempts']) {
      expect(columnsOf(table).length).toBeGreaterThan(0);
    }
    expect(indexNames('intent_selections')).toContain('uniq_active_selection');
  });

  it('is idempotent: a second startup does not disturb the migrated schema', async () => {
    await initDb();
    const before = columnsOf('transactions');

    closeDb();
    await initDb();

    expect(columnsOf('transactions')).toEqual(before);
    expect(indexNames('intent_selections')).toContain('uniq_active_selection');
  });
});

describe('P1 MongoDB parity', () => {
  /** The documented document shape for an active selection. */
  async function selectionCollection() {
    const db = createFakeDb();
    await ensureIndexes(db as unknown as MongoDbLike, 'P6');
    return db.collection('intentSelections');
  }

  it('enforces the same one-active-selection rule as SQLite', async () => {
    const collection = await selectionCollection();

    const active = (id: string) => ({
      _id: id,
      userId: 'user-1',
      intentId: 'intent-1',
      snapshotId: `snap-${id}`,
      isActive: true,
      selectedAt: '2026-01-01T00:00:00.000Z',
    });
    const superseded = (id: string) => ({
      _id: id,
      userId: 'user-1',
      intentId: 'intent-1',
      snapshotId: `snap-${id}`,
      isActive: false,
      selectedAt: '2026-01-01T00:00:00.000Z',
      supersededAt: '2026-01-01T00:01:00.000Z',
    });

    await collection.insertOne(active('sel-a') as never);
    await expect(collection.insertOne(active('sel-b') as never)).rejects.toThrow();

    // Superseding the first row frees the slot, and superseded rows accumulate.
    await collection.updateOne({ _id: 'sel-a' } as never, {
      $set: {
        isActive: false,
        supersededAt: '2026-01-01T00:01:00.000Z',
      },
    });
    await collection.insertOne(active('sel-b') as never);
    await collection.insertOne(superseded('sel-c') as never);
  });

  it('enforces order-attempt idempotency per user', async () => {
    const db = createFakeDb();
    await ensureIndexes(db as unknown as MongoDbLike, 'P6');
    const attempts = db.collection('orderAttempts');

    const attempt = (id: string, userId: string, key: string) => ({
      _id: id,
      userId,
      intentId: 'intent-1',
      selectionId: 'sel-a',
      snapshotId: 'snap-a',
      idempotencyKey: key,
      requestFingerprint: 'fp-1',
      status: 'RESERVED',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    await attempts.insertOne(attempt('att-1', 'user-1', 'key-1') as never);
    await expect(attempts.insertOne(attempt('att-2', 'user-1', 'key-1') as never)).rejects.toThrow();
    await attempts.insertOne(attempt('att-3', 'user-2', 'key-1') as never);
  });
});
