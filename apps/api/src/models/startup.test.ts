import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  initializePersistence,
  registerShutdownHandlers,
  type PersistenceDeps,
} from './startup.js';
import {
  getProductRepository,
  getSessionRepository,
  getTransactionRepository,
  getUserRepository,
  resetMongoDb,
  setPersistenceProvider,
} from './repositories.js';
import { MongoTransactionRepository } from '../services/transactions/MongoTransactionRepository.js';
import { MongoProductRepository } from '../services/discovery/MongoProductRepository.js';
import { MongoUserRepository } from '../services/auth/MongoUserRepository.js';
import { MongoSessionRepository } from '../services/auth/MongoSessionRepository.js';
import { createFakeDb } from '../test/fakeMongo.js';
import type { MongoConnection, MongoDbLike } from './mongoClient.js';
import type { MongoPhase } from './mongoIndexes.js';

/**
 * Startup/shutdown ordering, exercised entirely with injected fakes. No Atlas
 * connection, no listening server, no repository .env.
 */

const testConfig = vi.hoisted(() => ({
  dbPath: '',
  authInitialEmail: null as string | null,
  authInitialPassword: null as string | null,
  authSessionTtlMs: 60_000,
  persistenceProvider: 'sqlite',
}));

vi.mock('../config/env.js', () => ({ config: testConfig }));

afterEach(() => {
  setPersistenceProvider(null);
  resetMongoDb();
});

interface StartupState {
  initDbCalls: number;
  closeDbCalls: number;
  provisionCalls: number;
  connectCalls: number;
  indexCalls: number;
  closeCalls: number;
  indexesBeforeBind: boolean;
  indexPhases: MongoPhase[];
}

function makeDeps(
  state: StartupState,
  options: { failConnect?: boolean; failIndexes?: MongoPhase } = {},
): Partial<PersistenceDeps> {
  const db = createFakeDb();
  const connection: MongoConnection = {
    client: { connect: async () => undefined, db: () => db, close: async () => undefined },
    db: db as unknown as MongoDbLike,
  };
  return {
    initDb: async () => {
      state.initDbCalls += 1;
    },
    closeDb: () => {
      state.closeDbCalls += 1;
    },
    provisionInitialAuth: async () => {
      state.provisionCalls += 1;
    },
    connectMongo: async () => {
      state.connectCalls += 1;
      if (options.failConnect) throw new Error('connect failed');
      return connection;
    },
    ensureIndexes: async (_db, phase) => {
      state.indexCalls += 1;
      state.indexPhases.push(phase);
      if (options.failIndexes === phase) throw new Error('index failed');
    },
    closeMongo: async () => {
      state.closeCalls += 1;
    },
  };
}

function newState(): StartupState {
  return {
    initDbCalls: 0,
    closeDbCalls: 0,
    provisionCalls: 0,
    connectCalls: 0,
    indexCalls: 0,
    closeCalls: 0,
    indexesBeforeBind: false,
    indexPhases: [],
  };
}

describe('initializePersistence', () => {
  it('sqlite: initializes the sql.js database and never connects to MongoDB', async () => {
    const state = newState();
    const persistence = await initializePersistence('sqlite', makeDeps(state));

    expect(state.initDbCalls).toBe(1);
    expect(state.provisionCalls).toBe(1);
    expect(state.connectCalls).toBe(0);
    expect(state.indexCalls).toBe(0);
    expect(persistence.provider).toBe('sqlite');
    await persistence.close();
    await persistence.close();
    expect(state.closeDbCalls).toBe(1);
    expect(state.closeCalls).toBe(0);
  });

  it('sqlite: a provisioning failure closes the initialized database and aborts startup', async () => {
    const state = newState();
    const deps = makeDeps(state);
    deps.provisionInitialAuth = async () => {
      state.provisionCalls += 1;
      throw new Error('provision failed');
    };

    await expect(initializePersistence('sqlite', deps)).rejects.toThrow('provision failed');
    expect(state.initDbCalls).toBe(1);
    expect(state.closeDbCalls).toBe(1);
  });

  it('mongodb: connects, creates P2-B, P3, P4, P5, and P6 indexes, binds the handle, and never inits sql.js', async () => {
    const state = newState();
    const persistence = await initializePersistence('mongodb', makeDeps(state));

    expect(state.connectCalls).toBe(1);
    expect(state.indexCalls).toBe(5);
    expect(state.indexPhases).toEqual(['P2-B', 'P3', 'P4', 'P5', 'P6']);
    expect(state.initDbCalls).toBe(0); // every migrated repository is MongoDB-backed
    expect(persistence.provider).toBe('mongodb');
    // The composition root is now bound to Mongo for every migrated repository.
    expect(getTransactionRepository()).toBeInstanceOf(MongoTransactionRepository);
    expect(getProductRepository()).toBeInstanceOf(MongoProductRepository);
    expect(getUserRepository()).toBeInstanceOf(MongoUserRepository);
    expect(getSessionRepository()).toBeInstanceOf(MongoSessionRepository);
  });

  it('mongodb: a connection failure aborts initialization (no fallback, no bind)', async () => {
    const state = newState();
    await expect(
      initializePersistence('mongodb', makeDeps(state, { failConnect: true })),
    ).rejects.toThrow('connect failed');
    expect(state.indexCalls).toBe(0);
    expect(state.initDbCalls).toBe(0);
    // Nothing was bound, so a MongoDB accessor still fails closed.
    await expect(async () => getTransactionRepository()).rejects.toThrow();
  });

  it('mongodb: a P2-B index failure aborts initialization before the handle is bound', async () => {
    const state = newState();
    await expect(
      initializePersistence('mongodb', makeDeps(state, { failIndexes: 'P2-B' })),
    ).rejects.toThrow('index failed');
    expect(state.indexCalls).toBe(1);
    expect(state.closeCalls).toBe(1);
    expect(state.initDbCalls).toBe(0);
    expect(() => getTransactionRepository()).toThrow();
    expect(() => getProductRepository()).toThrow();
  });

  it('mongodb: a P3 index failure aborts initialization and does not bind a partially migrated handle', async () => {
    const state = newState();
    await expect(
      initializePersistence('mongodb', makeDeps(state, { failIndexes: 'P3' })),
    ).rejects.toThrow('index failed');
    expect(state.indexPhases).toEqual(['P2-B', 'P3']);
    expect(state.closeCalls).toBe(1);
    expect(state.initDbCalls).toBe(0);
    expect(() => getTransactionRepository()).toThrow();
    expect(() => getProductRepository()).toThrow();
    expect(() => getUserRepository()).toThrow();
    expect(() => getSessionRepository()).toThrow();
  });

  it('mongodb: a P4 index failure aborts initialization and does not bind a partially migrated handle', async () => {
    const state = newState();
    await expect(
      initializePersistence('mongodb', makeDeps(state, { failIndexes: 'P4' })),
    ).rejects.toThrow('index failed');
    expect(state.indexPhases).toEqual(['P2-B', 'P3', 'P4']);
    expect(state.closeCalls).toBe(1);
    expect(state.initDbCalls).toBe(0);
    expect(() => getTransactionRepository()).toThrow();
    expect(() => getProductRepository()).toThrow();
    expect(() => getUserRepository()).toThrow();
    expect(() => getSessionRepository()).toThrow();
  });

  it('mongodb: a P5 ownership-index failure aborts initialization before binding', async () => {
    const state = newState();
    await expect(
      initializePersistence('mongodb', makeDeps(state, { failIndexes: 'P5' })),
    ).rejects.toThrow('index failed');
    expect(state.indexPhases).toEqual(['P2-B', 'P3', 'P4', 'P5']);
    expect(state.closeCalls).toBe(1);
    expect(state.initDbCalls).toBe(0);
    expect(() => getTransactionRepository()).toThrow();
    expect(() => getUserRepository()).toThrow();
  });

  it('mongodb: close() releases the connection once and is idempotent', async () => {
    const state = newState();
    const persistence = await initializePersistence('mongodb', makeDeps(state));
    await persistence.close();
    await persistence.close();
    expect(state.closeCalls).toBe(1);
  });
});

describe('registerShutdownHandlers', () => {
  it('runs the shutdown once and exits, ignoring a second signal', async () => {
    let shutdowns = 0;
    let exits: number[] = [];
    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      exits.push(code ?? 0);
      return undefined as never;
    }) as typeof process.exit;

    const dispose = registerShutdownHandlers(async () => {
      shutdowns += 1;
    });

    try {
      process.emit('SIGTERM');
      process.emit('SIGTERM');
      await new Promise((r) => setTimeout(r, 20));
      expect(shutdowns).toBe(1);
      expect(exits.length).toBe(1);
      expect(exits[0]).toBe(0);
    } finally {
      dispose();
      process.exit = originalExit;
    }
  });

  it('exits with code 1 when shutdown fails', async () => {
    let exits: number[] = [];
    const originalExit = process.exit;
    const originalError = console.error;
    console.error = (() => undefined) as typeof console.error;
    process.exit = ((code?: number) => {
      exits.push(code ?? 0);
      return undefined as never;
    }) as typeof process.exit;

    const dispose = registerShutdownHandlers(async () => {
      throw new Error('shutdown failed');
    });

    try {
      process.emit('SIGINT');
      await new Promise((r) => setTimeout(r, 20));
      expect(exits.length).toBe(1);
      expect(exits[0]).toBe(1);
    } finally {
      dispose();
      process.exit = originalExit;
      console.error = originalError;
    }
  });

  it('dispose removes the handlers', () => {
    const before = process.listenerCount('SIGINT');
    const dispose = registerShutdownHandlers(async () => undefined);
    expect(process.listenerCount('SIGINT')).toBe(before + 1);
    dispose();
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});
