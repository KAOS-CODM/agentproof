import { MongoClient, type IndexDescription, type MongoClientOptions } from 'mongodb';
import { config } from '../config/env.js';

/**
 * MongoDB (Atlas) connection foundation — P0, activated by P2-B startup.
 *
 * Status: this module stays inert on import. It is connected only when the
 * startup path explicitly selects `PERSISTENCE_PROVIDER=mongodb` and calls
 * `connectMongo()`. When SQLite is selected nothing here runs. In MongoDB mode
 * all migrated repositories (including P3 offers/discoveries) use this handle.
 *
 * Design constraints honoured here:
 *   - Exactly one reusable `MongoClient` per API process (the module singleton).
 *   - Nothing connects on import; connection happens only when `connect()` /
 *     `connectMongo()` is explicitly invoked.
 *   - Connectivity is verified with a `ping`.
 *   - Connection and close are idempotent, and `close()` waits for an in-flight
 *     `connect()` so a late resolution cannot leak a client.
 *   - Missing configuration throws a clear error and NEVER falls back to SQLite,
 *     sql.js, or an in-memory database.
 *   - Credentials are never placed in error messages or logs.
 */

/** Thrown when MongoDB configuration is missing. Never triggers a fallback. */
export class MongoNotConfiguredError extends Error {
  constructor(missing: string) {
    super(
      `MongoDB is not configured: ${missing} is missing. Set MONGODB_URI and ` +
        `MONGODB_DB to enable MongoDB. There is no automatic fallback to SQLite, ` +
        `sql.js, or an in-memory database.`,
    );
    this.name = 'MongoNotConfiguredError';
  }
}

/** Thrown when a connection attempt fails or an unconnected client is used. */
export class MongoConnectionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MongoConnectionError';
  }
}

// ── Structural types so tests can inject fakes without a live cluster ────────
// The real `MongoClient` / `Db` / `Collection` satisfy these shapes, so the
// production factory returns a genuine driver client while tests return
// lightweight fakes.

export interface MongoCollectionLike {
  createIndexes(indexes: IndexDescription[]): Promise<string[]>;
}

export interface MongoDbLike {
  command(command: Record<string, unknown>): Promise<unknown>;
  collection(name: string): MongoCollectionLike;
}

export interface MongoClientLike {
  connect(): Promise<unknown>;
  db(name?: string): MongoDbLike;
  close(force?: boolean): Promise<void>;
}

export type MongoClientFactory = (uri: string, options: MongoClientOptions) => MongoClientLike;

export interface MongoConfig {
  uri: string;
  dbName: string;
}

export interface MongoConnection {
  client: MongoClientLike;
  db: MongoDbLike;
}

/** Credential-safe timeout/pool defaults. Kept small and conservative. */
export const DEFAULT_MONGO_CLIENT_OPTIONS: MongoClientOptions = {
  serverSelectionTimeoutMS: 5_000,
  maxPoolSize: 10,
};

const defaultMongoClientFactory: MongoClientFactory = (uri, options) =>
  new MongoClient(uri, options);

/**
 * Validate a URI/db-name pair, trimming and requiring both. Throws a
 * `MongoNotConfiguredError` naming the first missing value — it never returns a
 * partial/default configuration and never falls back to another store.
 */
export function validateMongoConfig(cfg: { uri?: string; dbName?: string }): MongoConfig {
  const uri = (cfg.uri ?? '').trim();
  const dbName = (cfg.dbName ?? '').trim();
  if (!uri) throw new MongoNotConfiguredError('MONGODB_URI');
  if (!dbName) throw new MongoNotConfiguredError('MONGODB_DB');
  return { uri, dbName };
}

/**
 * Resolve and validate MongoDB configuration from the server-side config
 * (`MONGODB_URI` / `MONGODB_DB`). Throws a `MongoNotConfiguredError` when either
 * is missing.
 */
export function resolveMongoConfig(
  source: { mongodbUri: string; mongodbDb: string } = config,
): MongoConfig {
  return validateMongoConfig({ uri: source.mongodbUri, dbName: source.mongodbDb });
}

/**
 * Strip credentials from any string that might be echoed into an error message.
 * Guards against a driver error (or our own message) leaking a connection
 * string that embeds `user:password@`.
 */
export function redactMongoUri(value: string): string {
  return value.replace(/(mongodb(?:\+srv)?:\/\/)[^@\s/]+@/gi, '$1<redacted>@');
}

function safeMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactMongoUri(raw);
}

/**
 * Owns a single `MongoClient` for the process. Instantiate once (see the
 * `mongo` singleton below); tests construct isolated instances with a fake
 * factory.
 */
export class MongoConnectionManager {
  private client: MongoClientLike | null = null;
  private database: MongoDbLike | null = null;
  private connecting: Promise<MongoConnection> | null = null;

  constructor(
    private readonly factory: MongoClientFactory = defaultMongoClientFactory,
    private readonly options: MongoClientOptions = DEFAULT_MONGO_CLIENT_OPTIONS,
  ) {}

  /**
   * Connect (once) and verify connectivity with a ping.
   *
   * Idempotent: repeated and concurrent calls reuse the same client. Throws
   * `MongoNotConfiguredError` when configuration is missing and
   * `MongoConnectionError` when the connection or ping fails.
   */
  async connect(configOverride?: MongoConfig): Promise<MongoConnection> {
    if (this.client && this.database) {
      return { client: this.client, db: this.database };
    }
    if (this.connecting) {
      return this.connecting;
    }

    const cfg = configOverride ? validateMongoConfig(configOverride) : resolveMongoConfig();
    const attempt = this.open(cfg);
    this.connecting = attempt;
    try {
      return await attempt;
    } finally {
      if (this.connecting === attempt) this.connecting = null;
    }
  }

  private async open(cfg: MongoConfig): Promise<MongoConnection> {
    let client: MongoClientLike | undefined;
    try {
      const created = this.factory(cfg.uri, this.options);
      client = created;
      await created.connect();
      const db = created.db(cfg.dbName);
      await db.command({ ping: 1 });
      this.client = created;
      this.database = db;
      return { client: created, db };
    } catch (err) {
      // Never leave a half-open client behind (the factory may also throw
      // synchronously for an invalid URI, in which case there is none).
      if (client) await client.close().catch(() => undefined);
      throw new MongoConnectionError(
        `Failed to connect to MongoDB database "${cfg.dbName}": ${safeMessage(err)}`,
        { cause: err },
      );
    }
  }

  /** The connected client. Throws if `connect()` has not succeeded. */
  getClient(): MongoClientLike {
    if (!this.client) {
      throw new MongoConnectionError(
        'MongoDB is not connected. Call connectMongo() before using the client.',
      );
    }
    return this.client;
  }

  /** The connected database handle. Throws if `connect()` has not succeeded. */
  getDb(): MongoDbLike {
    if (!this.database) {
      throw new MongoConnectionError(
        'MongoDB is not connected. Call connectMongo() before using the database.',
      );
    }
    return this.database;
  }

  isConnected(): boolean {
    return this.client !== null && this.database !== null;
  }

  /** Idempotent: closing an unconnected manager is a safe no-op. */
  async close(force?: boolean): Promise<void> {
    // Wait for any in-flight connect() to settle before tearing down. Without
    // this, a connect() that resolves *after* close() would set `this.client`/
    // `this.database` behind the close's back and leak a connected client.
    // `connecting` is cleared in connect()'s finally block, so awaiting it never
    // blocks on a later attempt.
    const inFlight = this.connecting;
    if (inFlight) await inFlight.catch(() => undefined);

    const client = this.client;
    this.client = null;
    this.database = null;
    if (!client) return;
    await client.close(force);
  }
}

/** The single per-process connection manager. */
export const mongo = new MongoConnectionManager();

/** Connect the process-wide client. Intended to be invoked from startup (P1). */
export function connectMongo(configOverride?: MongoConfig): Promise<MongoConnection> {
  return mongo.connect(configOverride);
}

export function getMongoDb(): MongoDbLike {
  return mongo.getDb();
}

export function getMongoClient(): MongoClientLike {
  return mongo.getClient();
}

export function isMongoConnected(): boolean {
  return mongo.isConnected();
}

/** Close the process-wide client (idempotent). Intended for graceful shutdown. */
export function closeMongo(force?: boolean): Promise<void> {
  return mongo.close(force);
}
