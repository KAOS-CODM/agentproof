import initSqlJs from 'sql.js';
import { createRequire } from 'node:module';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { config } from '../config/env.js';

const require = createRequire(import.meta.url);

type SqlJsDatabase = InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']>;

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;
let db: SqlJsDatabase | null = null;
let activeDbPath: string | null = null;
let saveSequence = 0;

/**
 * Persist the complete in-memory sql.js database to disk using an atomic
 * replace. sql.js has no WAL/journal of its own, so the only durable unit is a
 * full database export.
 *
 * The temporary file is created in the destination directory (so rename stays
 * on the same volume), flushed, and then renamed over the target. A crash before
 * the rename leaves the previous database intact; a crash after it leaves the
 * new complete file. The temporary file is removed on failure. An empty export
 * is refused so a broken in-memory database can never replace a valid file.
 */
function writeDatabaseFile(database: SqlJsDatabase, dbPath: string): void {
  const data = database.export();
  if (data.byteLength === 0) {
    throw new Error('Refusing to persist an empty SQLite database export');
  }

  const tempPath = `${dbPath}.${process.pid}.${saveSequence}.${randomBytes(4).toString('hex')}.tmp`;
  saveSequence += 1;

  let fd: number | null = null;
  let renamed = false;
  try {
    fd = openSync(tempPath, 'wx', 0o600);
    const buffer = Buffer.from(data);
    let offset = 0;
    while (offset < buffer.length) {
      const written = writeSync(fd, buffer, offset, buffer.length - offset);
      if (written <= 0) {
        throw new Error('SQLite database write made no progress');
      }
      offset += written;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = null;

    renameSync(tempPath, dbPath);
    renamed = true;
    syncParentDirectory(dirname(dbPath));
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Best effort cleanup; the original error is more useful.
      }
    }
    if (!renamed) {
      try {
        unlinkSync(tempPath);
      } catch {
        // The temp file may not have been created.
      }
    }
    throw new Error(`Failed to persist SQLite database at ${dbPath}`, { cause: err });
  }
}

/**
 * On POSIX, fsync the directory so the rename itself survives a crash. Windows
 * does not support opening a directory this way; its rename durability is left
 * to the filesystem/OS after the file data has been flushed.
 */
function syncParentDirectory(dbDir: string): void {
  if (process.platform === 'win32') return;
  let fd: number | null = null;
  try {
    fd = openSync(dbDir, 'r');
    fsyncSync(fd);
  } catch {
    // Directory fsync is best effort and not supported on every platform.
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Wrap the mutating sql.js entry points so a completed write is durable before
 * the caller observes success. sql.js executes synchronously and keeps the
 * database in memory, so without this export the file would only be updated on
 * shutdown.
 *
 * Trade-off: each mutation rewrites the whole database. That is appropriate for
 * this small, single-process local application but is not a high-write-volume
 * database design. Concurrent API processes sharing one DB_PATH are not
 * supported because they would race on whole-file replacement.
 */
function enableAutoPersistence(database: SqlJsDatabase, dbPath: string): SqlJsDatabase {
  const originalRun = database.run.bind(database);
  database.run = ((sql: string, params?: Parameters<SqlJsDatabase['run']>[1]) => {
    const result = originalRun(sql, params);
    writeDatabaseFile(database, dbPath);
    return result;
  }) as SqlJsDatabase['run'];

  const originalExec = database.exec.bind(database);
  database.exec = ((sql: string, params?: Parameters<SqlJsDatabase['exec']>[1]) => {
    const result = originalExec(sql, params);
    writeDatabaseFile(database, dbPath);
    return result;
  }) as SqlJsDatabase['exec'];

  const originalPrepare = database.prepare.bind(database);
  database.prepare = ((sql: string, params?: Parameters<SqlJsDatabase['prepare']>[1]) => {
    const statement = originalPrepare(sql, params);
    const originalStatementRun = statement.run.bind(statement);
    statement.run = ((values?: Parameters<typeof originalStatementRun>[0]) => {
      const result = originalStatementRun(values);
      writeDatabaseFile(database, dbPath);
      return result;
    }) as typeof statement.run;
    return statement;
  }) as SqlJsDatabase['prepare'];

  return database;
}

export async function initDb(): Promise<void> {
  if (db) {
    if (activeDbPath !== config.dbPath) {
      throw new Error(
        `SQLite database is already open at ${activeDbPath}; close it before opening ${config.dbPath}`,
      );
    }
    return;
  }

  if (!SQL) {
    const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
    SQL = await initSqlJs({
      locateFile: () => wasmPath,
    });
  }

  const dbPath = config.dbPath;
  const dbDir = dirname(dbPath);
  mkdirSync(dbDir, { recursive: true });

  let opened: SqlJsDatabase;
  if (existsSync(dbPath)) {
    const info = statSync(dbPath);
    if (!info.isFile()) {
      throw new Error(`Configured SQLite database path is not a file: ${dbPath}`);
    }
    if (info.size === 0) {
      throw new Error(
        `Refusing to initialize from an empty SQLite database file at ${dbPath}. ` +
          `Remove it manually only if you intend to start a new database.`,
      );
    }

    const fileBuffer = readFileSync(dbPath);
    let candidate: SqlJsDatabase | null = null;
    try {
      candidate = new SQL.Database(fileBuffer);
      // sql.js defers some header validation until the first query. Force a
      // read here so a corrupt file fails before migration or persistence.
      candidate.exec('SELECT count(*) FROM sqlite_master');
      opened = candidate;
    } catch (err) {
      try {
        candidate?.close();
      } catch {
        // ignore
      }
      throw new Error(
        `Failed to open existing SQLite database at ${dbPath}; the file was not modified`,
        { cause: err },
      );
    }
  } else {
    opened = new SQL.Database();
  }

  try {
    migrate(opened);
    // Persist the new database or any schema migration immediately. This also
    // proves the path is writable before the server starts accepting requests.
    writeDatabaseFile(opened, dbPath);
  } catch (err) {
    opened.close();
    throw err;
  }

  activeDbPath = dbPath;
  db = enableAutoPersistence(opened, dbPath);
}

export function getDb(): SqlJsDatabase {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

export function saveDb(): void {
  if (!db) return;
  if (!activeDbPath) {
    throw new Error('SQLite database has no active file path');
  }
  writeDatabaseFile(db, activeDbPath);
}

export function closeDb(): void {
  if (!db) return;
  // If this throws, keep the handle and path intact so shutdown reports failure
  // and a later retry can still flush rather than silently discarding changes.
  saveDb();
  const closing = db;
  db = null;
  activeDbPath = null;
  closing.close();
}

function tableHasColumn(
  database: InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']>,
  table: string,
  column: string,
): boolean {
  try {
    const stmt = database.prepare(`PRAGMA table_info(${table})`);
    while (stmt.step()) {
      const row = stmt.get();
      if (Array.isArray(row)) {
        // cid,name,type,notnull,dflt_value,pk
        if (row[1] === column) {
          stmt.free();
          return true;
        }
      } else if (row && typeof row === 'object') {
        const name = (row as any).name;
        if (name === column) {
          stmt.free();
          return true;
        }
      }
    }
    stmt.free();
  } catch {
    // ignore
  }
  return false;
}

function migrate(database: InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']>): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS intents (
      id TEXT PRIMARY KEY,
      user_id TEXT,
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

    -- P3: per-intent discovery associations, independent of the shared product
    -- offer row so one intent cannot overwrite another's discovery.
    CREATE TABLE IF NOT EXISTS intent_discoveries (
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

    -- P7: immutable per-intent offer snapshots. Insert-only: a later refresh of
    -- the shared products row never rewrites what an earlier workflow saw.
    CREATE TABLE IF NOT EXISTS intent_offer_snapshots (
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
      -- P6: policy input the snapshot needs to be self-sufficient. Appended
      -- (never inserted mid-table) so fresh and migrated databases share the
      -- same column order.
      category TEXT
    );

    -- P4/P5: account/session persistence. Emails are stored normalized,
    -- passwords as one-way hashes, and sessions only by token hash.
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS policy_evaluations (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      intent_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      result TEXT NOT NULL,
      confirmation_required INTEGER NOT NULL DEFAULT 0,
      rule_results_json TEXT NOT NULL,
      evaluated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transactions (
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
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS evidence_records (
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

    -- P6 (schema only; behaviour lands in later phases): the durable record of
    -- which immutable offer snapshot a user actually selected for one intent.
    --
    -- Active-selection representation is explicit and adapter-neutral:
    --   active   -> is_active = 1 AND superseded_at IS NULL
    --   history  -> is_active = 0 AND superseded_at IS NOT NULL
    -- A unique index over "intent_id WHERE is_active = 1" therefore enforces at
    -- most one active selection per intent while leaving every superseded row
    -- unconstrained. The CHECK below keeps the two columns from disagreeing;
    -- the MongoDB equivalent uses a partial filter on "{ isActive: true }"
    -- (a nil/absent field cannot be expressed as a partial filter).
    CREATE TABLE IF NOT EXISTS intent_selections (
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

    -- P6 (schema only): a user's explicit approval of one selection. Deliberately
    -- not "approval_requests", which requires a transaction id and therefore
    -- cannot represent a decision made before any order exists.
    CREATE TABLE IF NOT EXISTS purchase_approvals (
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

    -- P6 (schema only): one idempotent order-creation attempt per request key.
    -- The unique (user_id, idempotency_key) index is what makes a retry a
    -- lookup instead of a second PayPal order.
    CREATE TABLE IF NOT EXISTS order_attempts (
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
      -- N3: the provider debug id is the only reconciliation handle available
      -- when a create-order call fails after possibly creating an order.
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

    CREATE INDEX IF NOT EXISTS idx_evidence_transaction ON evidence_records(transaction_id);
    CREATE INDEX IF NOT EXISTS idx_evidence_intent ON evidence_records(intent_id);
    CREATE INDEX IF NOT EXISTS idx_evidence_timestamp ON evidence_records(timestamp);
    CREATE INDEX IF NOT EXISTS idx_policy_intent ON policy_evaluations(intent_id);
    CREATE INDEX IF NOT EXISTS idx_intent_discoveries_intent
      ON intent_discoveries(intent_id, discovered_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

    -- P6: the single active selection per intent. Partial, so superseded
    -- history rows never participate in the uniqueness rule. This index is the
    -- constraint that keeps concurrent selections down to one winner; the
    -- repository only has to order its writes so a partial failure fails closed.
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_selection
      ON intent_selections(intent_id) WHERE is_active = 1;
    CREATE INDEX IF NOT EXISTS idx_intent_selections_user
      ON intent_selections(user_id, intent_id);
    CREATE INDEX IF NOT EXISTS idx_purchase_approvals_user_status
      ON purchase_approvals(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_purchase_approvals_intent_status
      ON purchase_approvals(intent_id, status);
    CREATE INDEX IF NOT EXISTS idx_purchase_approvals_selection
      ON purchase_approvals(selection_id);
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_attempt_idempotency
      ON order_attempts(user_id, idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_order_attempts_user_created
      ON order_attempts(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_order_attempts_status
      ON order_attempts(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_order_attempts_transaction
      ON order_attempts(transaction_id);
  `);

  if (!tableHasColumn(database, 'intents', 'user_id')) {
    database.exec('ALTER TABLE intents ADD COLUMN user_id TEXT');
  }
  if (!tableHasColumn(database, 'policy_evaluations', 'user_id')) {
    database.exec('ALTER TABLE policy_evaluations ADD COLUMN user_id TEXT');
  }
  if (!tableHasColumn(database, 'transactions', 'user_id')) {
    database.exec('ALTER TABLE transactions ADD COLUMN user_id TEXT');
  }
  if (!tableHasColumn(database, 'evidence_records', 'user_id')) {
    database.exec('ALTER TABLE evidence_records ADD COLUMN user_id TEXT');
  }
  if (!tableHasColumn(database, 'intent_discoveries', 'snapshot_id')) {
    database.exec('ALTER TABLE intent_discoveries ADD COLUMN snapshot_id TEXT');
  }

  // P6: binding columns. All nullable and additive, so a pre-P6 transaction
  // stays readable and is simply classified as "legacy unbound" at read time.
  // Nothing is backfilled: a historical transaction is never given a fabricated
  // snapshot, selection, or approval.
  const transactionBindings: Array<[string, string]> = [
    ['snapshot_id', 'TEXT'],
    ['selection_id', 'TEXT'],
    ['approval_id', 'TEXT'],
    ['order_attempt_id', 'TEXT'],
    ['product_source', 'TEXT'],
    ['paypal_invoice_id', 'TEXT'],
    ['authorization_fingerprint', 'TEXT'],
  ];
  for (const [column, type] of transactionBindings) {
    if (!tableHasColumn(database, 'transactions', column)) {
      database.exec(`ALTER TABLE transactions ADD COLUMN ${column} ${type}`);
    }
  }

  if (!tableHasColumn(database, 'policy_evaluations', 'snapshot_id')) {
    database.exec('ALTER TABLE policy_evaluations ADD COLUMN snapshot_id TEXT');
  }
  if (!tableHasColumn(database, 'policy_evaluations', 'selection_id')) {
    database.exec('ALTER TABLE policy_evaluations ADD COLUMN selection_id TEXT');
  }
  if (!tableHasColumn(database, 'policy_evaluations', 'ruleset_version')) {
    database.exec('ALTER TABLE policy_evaluations ADD COLUMN ruleset_version TEXT');
  }

  // P6: snapshots must be able to reproduce the purpose rule from the
  // authoritative offer alone, so no order path has to read the mutable
  // shared products row. Existing snapshots keep NULL (never guessed).
  if (!tableHasColumn(database, 'intent_offer_snapshots', 'category')) {
    database.exec('ALTER TABLE intent_offer_snapshots ADD COLUMN category TEXT');
  }

  // Ownership indexes must be created only after ALTER TABLE has added the
  // columns to an existing pre-P5 database; creating them in the block above
  // would fail on a missing column and abort startup. Migration failures are
  // intentionally not swallowed: a partially migrated store must not be served.
  database.exec('CREATE INDEX IF NOT EXISTS idx_evidence_user_timestamp ON evidence_records(user_id, timestamp)');
  database.exec(
    'CREATE INDEX IF NOT EXISTS idx_intent_offer_snapshots_intent ' +
      'ON intent_offer_snapshots(intent_id, source, product_id, captured_at DESC)',
  );
  database.exec(
    'CREATE INDEX IF NOT EXISTS idx_intent_offer_snapshots_user ' +
      'ON intent_offer_snapshots(user_id, intent_id)',
  );
  database.exec('CREATE INDEX IF NOT EXISTS idx_policy_user ON policy_evaluations(user_id)');
  database.exec('CREATE INDEX IF NOT EXISTS idx_intents_user_created ON intents(user_id, created_at DESC)');
  database.exec('CREATE INDEX IF NOT EXISTS idx_transactions_user_created ON transactions(user_id, created_at DESC)');
}
