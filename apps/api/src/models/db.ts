import initSqlJs from 'sql.js';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config/env.js';

const require = createRequire(import.meta.url);

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;
let db: InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']> | null = null;

export async function initDb(): Promise<void> {
  if (db) return;

  if (!SQL) {
    const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
    SQL = await initSqlJs({
      locateFile: () => wasmPath,
    });
  }

  const dbDir = dirname(config.dbPath);
  mkdirSync(dbDir, { recursive: true });

  if (existsSync(config.dbPath)) {
    const fileBuffer = readFileSync(config.dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  migrate(db);
}

export function getDb(): InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']> {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

export function saveDb(): void {
  if (!db) return;
  const data = db.export();
  writeFileSync(config.dbPath, Buffer.from(data));
}

export function closeDb(): void {
  if (db) {
    saveDb();
    db.close();
    db = null;
  }
}

function migrate(database: InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']>): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS intents (
      id TEXT PRIMARY KEY,
      raw_input TEXT NOT NULL,
      structured_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      parsed_at TEXT,
      validated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      price REAL NOT NULL,
      currency TEXT NOT NULL,
      brand TEXT,
      condition TEXT,
      category TEXT,
      image_url TEXT,
      product_url TEXT,
      metadata_json TEXT,
      discovered_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS policy_evaluations (
      id TEXT PRIMARY KEY,
      intent_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      result TEXT NOT NULL,
      confirmation_required INTEGER NOT NULL DEFAULT 0,
      rule_results_json TEXT NOT NULL,
      evaluated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transactions (
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

    CREATE TABLE IF NOT EXISTS evidence_records (
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

    CREATE TABLE IF NOT EXISTS approval_requests (
      id TEXT PRIMARY KEY,
      transaction_id TEXT NOT NULL,
      action TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT,
      evidence_ids_json TEXT
    );

    CREATE TABLE IF NOT EXISTS disputes (
      id TEXT PRIMARY KEY,
      transaction_id TEXT NOT NULL,
      paypal_dispute_id TEXT,
      status TEXT NOT NULL,
      reason TEXT,
      opened_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_evidence_transaction ON evidence_records(transaction_id);
    CREATE INDEX IF NOT EXISTS idx_evidence_intent ON evidence_records(intent_id);
    CREATE INDEX IF NOT EXISTS idx_evidence_timestamp ON evidence_records(timestamp);
    CREATE INDEX IF NOT EXISTS idx_policy_intent ON policy_evaluations(intent_id);
  `);
}
