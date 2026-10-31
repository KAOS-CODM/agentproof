import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';
import { closeDb, getDb, initDb } from './db.js';

const require = createRequire(import.meta.url);
const tempDir = mkdtempSync(join(tmpdir(), 'agentproof-db-migration-'));
const legacyPath = join(tempDir, 'legacy.db');
const testConfig = vi.hoisted(() => ({
  dbPath: '',
  persistenceProvider: 'sqlite',
}));

// Never load the repository's real .env or default database path.
vi.mock('../config/env.js', () => ({ config: testConfig }));
testConfig.dbPath = legacyPath;

afterAll(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

/**
 * P5 adds ownership columns to existing tables. The migration must add those
 * columns BEFORE creating indexes that reference them, otherwise a pre-P5
 * database fails to start.
 */
describe('SQLite P5 ownership migration', () => {
  it('upgrades a pre-P5 database and leaves legacy rows ownerless', async () => {
    const SQL = await initSqlJs({
      locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm'),
    });
    const legacy = new SQL.Database();
    legacy.exec(`
      CREATE TABLE intents (
        id TEXT PRIMARY KEY,
        raw_input TEXT NOT NULL,
        structured_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        parsed_at TEXT,
        validated_at TEXT
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
      CREATE TABLE evidence_records (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        actor TEXT NOT NULL,
        transaction_id TEXT,
        intent_id TEXT,
        approval_request_id TEXT,
        policy_evaluation_id TEXT,
        data_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );

      INSERT INTO intents (id, raw_input, structured_json, status, created_at)
        VALUES ('legacy-intent', 'legacy', '{}', 'VALIDATED', '2025-01-01T00:00:00.000Z');
      INSERT INTO evidence_records (id, event_type, timestamp, actor, data_json, metadata_json)
        VALUES ('legacy-evidence', 'INTENT_CREATED', '2025-01-01T00:00:00.000Z', 'user', '{}', '{}');
    `);
    writeFileSync(legacyPath, Buffer.from(legacy.export()));
    legacy.close();

    testConfig.dbPath = legacyPath;
    await initDb();

    const db = getDb();
    for (const table of ['intents', 'policy_evaluations', 'transactions', 'evidence_records']) {
      const columns = db.exec(`PRAGMA table_info(${table})`);
      const names = (columns[0]?.values ?? []).map((row) => row[1]);
      expect(names).toContain('user_id');
    }

    const legacyRow = db.exec(
      "SELECT user_id FROM evidence_records WHERE id = 'legacy-evidence'",
    );
    expect(legacyRow[0]?.values[0]?.[0]).toBeNull();

    const indexes = db.exec(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_evidence_user_timestamp'",
    );
    expect(indexes[0]?.values).toHaveLength(1);

    // P7 snapshot migration: the snapshot table is created and the legacy
    // association gains a nullable snapshot_id without fabricating a URL.
    const snapshotColumns = db.exec('PRAGMA table_info(intent_offer_snapshots)');
    const snapshotNames = (snapshotColumns[0]?.values ?? []).map((row) => row[1]);
    for (const column of [
      'id',
      'user_id',
      'intent_id',
      'source',
      'product_id',
      'offer_url',
      'merchant',
      'price',
      'currency',
      'compare_at_price',
      'max_commission_rate',
      'captured_at',
    ]) {
      expect(snapshotNames).toContain(column);
    }

    const discoveryColumns = db.exec('PRAGMA table_info(intent_discoveries)');
    const discoveryNames = (discoveryColumns[0]?.values ?? []).map((row) => row[1]);
    expect(discoveryNames).toContain('snapshot_id');

    const snapshotIndexes = db.exec(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_intent_offer_snapshots_intent'",
    );
    expect(snapshotIndexes[0]?.values).toHaveLength(1);
  });
});
