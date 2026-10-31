import dns from 'dns';
import type { Db } from 'mongodb';
import { closeDb, initDb } from './db.js';
import {
  connectMongo as defaultConnectMongo,
  closeMongo as defaultCloseMongo,
  type MongoConnection,
  type MongoDbLike,
} from './mongoClient.js';
import { ensureIndexes as defaultEnsureIndexes, type MongoPhase } from './mongoIndexes.js';
import { resolvePersistenceProvider, type PersistenceProvider } from './persistenceProvider.js';
import { setMongoDb, setPersistenceProvider } from './repositories.js';
import { getUserRepository, getSessionRepository } from './repositories.js';
import { config } from '../config/env.js';
import { AuthService } from '../services/auth/AuthService.js';

/**
 * Persistence startup/shutdown orchestration — P2-B, extended by P3 and P4.
 *
 * Kept separate from the HTTP server so it can be tested with injected fakes and
 * so the ordering rule is explicit: the server must not accept requests until
 * the selected persistence provider is fully initialized.
 *
 * Ordering:
 *   - `sqlite`  → load or create the configured file, migrate, provision the
 *     initial account, and only then serve traffic. No MongoDB configuration is
 *     required and no MongoDB connection is made.
 *   - `mongodb` → connect (ping-verified), create the P2-B, P3, P4, P5, and P6
 *     indexes, then bind the handle. Every migrated repository (including offers,
 *     intent discoveries, users, sessions, and the P6 selection/approval/attempt
 *     collections) uses MongoDB, so sql.js is not initialized. Any failure
 *     rejects and aborts startup — there is no fallback.
 *
 * Shutdown flushes and closes the selected resources idempotently.
 */

export async function provisionInitialAuth(): Promise<void> {
  const email = config.authInitialEmail;
  const password = config.authInitialPassword;
  if (!email && !password) {
    return;
  }
  if (!email || !password) {
    throw new Error('Both AUTH_INITIAL_EMAIL and AUTH_INITIAL_PASSWORD must be set together');
  }
  const authService = new AuthService({
    users: getUserRepository(),
    sessions: getSessionRepository(),
    sessionTtlMs: config.authSessionTtlMs,
  });
  const result = await authService.provisionInitialUser(email, password);
  if (result.created) {
    try {
      console.log(`Initial auth user provisioned: ${result.userId}`);
    } catch {
      // ignore
    }
  }
}

export interface PersistenceDeps {
  connectMongo: () => Promise<MongoConnection>;
  closeMongo: () => Promise<void>;
  ensureIndexes: (db: MongoDbLike, phase: MongoPhase) => Promise<void>;
  initDb: () => Promise<void>;
  closeDb: () => void;
  provisionInitialAuth: () => Promise<void>;
}

const defaultDeps: PersistenceDeps = {
  connectMongo: () => defaultConnectMongo(),
  closeMongo: () => defaultCloseMongo(),
  ensureIndexes: (db, phase) => defaultEnsureIndexes(db, phase),
  initDb,
  closeDb,
  provisionInitialAuth,
};

export interface InitializedPersistence {
  provider: PersistenceProvider;
  /** Release the resources owned by this initialization. Idempotent. */
  close: () => Promise<void>;
}

/**
 * Initialize the selected persistence provider. Rejects clearly on any failure;
 * callers must not begin listening until this resolves.
 */
export async function initializePersistence(
  provider: PersistenceProvider = resolvePersistenceProvider(),
  deps: Partial<PersistenceDeps> = {},
): Promise<InitializedPersistence> {
  const d: PersistenceDeps = { ...defaultDeps, ...deps };

  // Bind the selected provider on the composition root so the accessors resolve
  // the same backend that was initialized here (rather than re-reading env).
  setPersistenceProvider(provider);

  // Configure process-level DNS resolver to enable MongoDB Atlas SRV resolution.
  // The default Windows DNS resolver (127.0.0.1) does not support SRV records;
  // using Google's public DNS (8.8.8.8) resolves the Atlas endpoints reliably.
  dns.setServers(['8.8.8.8']);

  if (provider === 'sqlite') {
    await d.initDb();
    try {
      await d.provisionInitialAuth();
    } catch (err) {
      // initDb succeeded, so close the handle on a provisioning failure. The
      // database has already been flushed; this releases memory and keeps the
      // process from retaining a half-started persistence layer.
      try {
        d.closeDb();
      } catch {
        // Preserve the provisioning error as the startup failure.
      }
      throw err;
    }

    let closed = false;
    return {
      provider,
      close: async () => {
        if (closed) return;
        d.closeDb();
        closed = true;
      },
    };
  }

  // MongoDB: connect + index BEFORE anything is served. P3 product/discovery
  // and P4 user/session collections are initialized after the P2-B collections;
  // a failure in any phase aborts startup rather than leaving a partially
  // migrated backend live.
  let connection: MongoConnection | undefined;
  let bound = false;
  try {
    connection = await d.connectMongo();
    await d.ensureIndexes(connection.db, 'P2-B');
    await d.ensureIndexes(connection.db, 'P3');
    await d.ensureIndexes(connection.db, 'P4');
    await d.ensureIndexes(connection.db, 'P5');
    await d.ensureIndexes(connection.db, 'P6');
    setMongoDb(connection.db as unknown as Db);
    bound = true;
    await d.provisionInitialAuth();
  } catch (err) {
    if (connection) {
      await d.closeMongo().catch(() => undefined);
    }
    if (bound) {
      // Ensure no stale Mongo binding remains if initialization fails mid-way.
      try {
        const { resetMongoDb } = await import('./repositories.js');
        resetMongoDb();
      } catch {
        // best effort
      }
    }
    throw err;
  }

  let closed = false;
  return {
    provider,
    close: async () => {
      if (closed) return;
      closed = true;
      await d.closeMongo();
    },
  };
}

/**
 * Register SIGINT/SIGTERM handlers that close persistence then exit. Returns a
 * disposer so tests (and repeated startup) can remove the handlers.
 */
export function registerShutdownHandlers(
  shutdown: () => Promise<void>,
  options: { onSignal?: (signal: NodeJS.Signals) => void } = {},
): () => void {
  let handling = false;
  const handle = (signal: NodeJS.Signals) => {
    if (handling) return;
    handling = true;
    options.onSignal?.(signal);
    void shutdown()
      .then(() => {
        process.exit(0);
      })
      .catch((err) => {
        // Do not conceal shutdown failures; log to stderr and exit nonzero.
        try {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`Shutdown failed: ${message}`);
        } catch {
          // ignore logging failures
        }
        process.exit(1);
      });
  };
  const onInt = () => handle('SIGINT');
  const onTerm = () => handle('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  return () => {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
  };
}

/** Sensible default for a process that also runs an HTTP server. */
export function makeServerShutdown(
  server: { close: (cb: (err?: Error) => void) => void },
  persistence: InitializedPersistence,
): () => Promise<void> {
  return () =>
    new Promise<void>((resolve, reject) => {
      server.close(async (err) => {
        try {
          await persistence.close();
        } catch (closeErr) {
          reject(closeErr as Error);
          return;
        }
        if (err) reject(err);
        else resolve();
      });
    });
}

// Re-export for callers that wire the process-wide singleton.
export type { MongoDbLike };
