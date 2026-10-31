import initSqlJs from 'sql.js';

export type SqlJsDatabase = InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']>;

const sqlJsReady = initSqlJs();

/**
 * Create a fresh in-memory sql.js database with the schema needed by the P1a
 * repositories.
 *
 * The DDL mirrors the relevant tables in `models/db.ts`. It is duplicated here
 * (rather than imported) so these tests exercise the repository SQL directly
 * without bootstrapping the whole application database.
 */
export async function createTestDatabase(): Promise<SqlJsDatabase> {
  const SQL = await sqlJsReady;
  const db = new SQL.Database();
  db.exec(`
    CREATE TABLE intents (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      raw_input TEXT NOT NULL,
      structured_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      parsed_at TEXT,
      validated_at TEXT
    );

    CREATE TABLE products (
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

    CREATE TABLE intent_discoveries (
      intent_id TEXT NOT NULL,
      source TEXT NOT NULL,
      product_id TEXT NOT NULL,
      discovered_at TEXT NOT NULL,
      evaluation_id TEXT,
      decision TEXT,
      confirmation_required INTEGER,
      snapshot_id TEXT,
      PRIMARY KEY (intent_id, source, product_id)
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
      captured_at TEXT NOT NULL,
      category TEXT
    );

    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    );

    CREATE TABLE policy_evaluations (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      intent_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      result TEXT NOT NULL,
      confirmation_required INTEGER NOT NULL DEFAULT 0,
      rule_results_json TEXT NOT NULL,
      evaluated_at TEXT NOT NULL,
      snapshot_id TEXT,
      selection_id TEXT,
      ruleset_version TEXT
    );

    CREATE TABLE evidence_records (
      id TEXT PRIMARY KEY,
      user_id TEXT,
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

    CREATE TABLE transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      intent_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      policy_evaluation_id TEXT NOT NULL,
      paypal_order_id TEXT,
      paypal_capture_id TEXT,
      amount REAL NOT NULL,
      currency TEXT NOT NULL,
      financial_state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      snapshot_id TEXT,
      selection_id TEXT,
      approval_id TEXT,
      order_attempt_id TEXT,
      product_source TEXT,
      paypal_invoice_id TEXT,
      authorization_fingerprint TEXT
    );

    -- P6: mirrors models/db.ts. Active state is explicit so the same partial
    -- unique rule can be expressed by both persistence adapters.
    CREATE TABLE intent_selections (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      intent_id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      source TEXT NOT NULL,
      product_id TEXT NOT NULL,
      price REAL NOT NULL,
      currency TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      selected_at TEXT NOT NULL,
      superseded_at TEXT,
      CHECK (
        (is_active = 1 AND superseded_at IS NULL) OR
        (is_active = 0 AND superseded_at IS NOT NULL)
      )
    );

    CREATE UNIQUE INDEX uniq_active_selection
      ON intent_selections(intent_id) WHERE is_active = 1;

    CREATE TABLE purchase_approvals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      intent_id TEXT NOT NULL,
      selection_id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      policy_evaluation_id TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      decided_at TEXT,
      decided_by_user_id TEXT,
      consumed_at TEXT,
      consumed_by_attempt_id TEXT,
      CHECK (
        status IN ('PENDING', 'GRANTED', 'DENIED', 'EXPIRED', 'SUPERSEDED', 'CONSUMED')
      )
    );

    CREATE TABLE order_attempts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      intent_id TEXT NOT NULL,
      selection_id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      approval_id TEXT,
      idempotency_key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL,
      paypal_order_id TEXT,
      paypal_invoice_id TEXT,
      paypal_debug_id TEXT,
      transaction_id TEXT,
      failure_code TEXT,
      request_started_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        status IN (
          'RESERVED', 'IN_FLIGHT', 'PAYPAL_CREATED', 'PERSISTED',
          'FAILED', 'OUTCOME_UNKNOWN'
        )
      )
    );

    CREATE UNIQUE INDEX uniq_attempt_idempotency
      ON order_attempts(user_id, idempotency_key);
  `);
  return db;
}
