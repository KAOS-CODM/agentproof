import { describe, it, expect } from 'vitest';
import type { IndexDescription, MongoClientOptions } from 'mongodb';
import {
  MongoConnectionManager,
  MongoConnectionError,
  MongoNotConfiguredError,
  resolveMongoConfig,
  redactMongoUri,
  validateMongoConfig,
  type MongoClientLike,
  type MongoDbLike,
} from './mongoClient.js';

// ── Injected fakes (no live Atlas cluster, no network) ──────────────────────

interface FakeState {
  factoryCalls: number;
  connectCalls: number;
  closeCalls: number;
  lastCloseForce: boolean | undefined;
  dbNames: string[];
  pingCalls: number;
  lastUri: string | undefined;
  lastOptions: MongoClientOptions | undefined;
  failConnect?: Error;
  failPing?: Error;
}

function newState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    factoryCalls: 0,
    connectCalls: 0,
    closeCalls: 0,
    lastCloseForce: undefined,
    dbNames: [],
    pingCalls: 0,
    lastUri: undefined,
    lastOptions: undefined,
    ...overrides,
  };
}

function fakeDb(state: FakeState): MongoDbLike {
  return {
    command: async () => {
      state.pingCalls += 1;
      if (state.failPing) throw state.failPing;
      return { ok: 1 };
    },
    collection: (_name: string) => ({
      createIndexes: async (_indexes: IndexDescription[]) => [],
    }),
  };
}

function fakeClient(state: FakeState): MongoClientLike {
  const client: MongoClientLike = {
    connect: async () => {
      state.connectCalls += 1;
      if (state.failConnect) throw state.failConnect;
      return client;
    },
    db: (name?: string) => {
      state.dbNames.push(name ?? '');
      return fakeDb(state);
    },
    close: async (force?: boolean) => {
      state.closeCalls += 1;
      state.lastCloseForce = force;
    },
  };
  return client;
}

function makeManager(state: FakeState): MongoConnectionManager {
  return new MongoConnectionManager((uri, options) => {
    state.factoryCalls += 1;
    state.lastUri = uri;
    state.lastOptions = options;
    return fakeClient(state);
  }, {});
}

const validConfig = { uri: 'mongodb://127.0.0.1:27017', dbName: 'agentproof_test' };

// ── Configuration validation ────────────────────────────────────────────────

describe('mongo configuration validation', () => {
  it('rejects a missing MONGODB_URI with a clear, non-fallback error', () => {
    const err = (() => {
      try {
        resolveMongoConfig({ mongodbUri: '', mongodbDb: 'agentproof' });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(MongoNotConfiguredError);
    expect((err as Error).message).toContain('MONGODB_URI');
    expect((err as Error).message).toMatch(/no automatic fallback/i);
  });

  it('rejects a missing MONGODB_DB when a URI is present', () => {
    expect(() =>
      resolveMongoConfig({ mongodbUri: 'mongodb://host', mongodbDb: '' }),
    ).toThrow(MongoNotConfiguredError);
  });

  it('treats whitespace-only values as missing', () => {
    expect(() => validateMongoConfig({ uri: '   ', dbName: 'agentproof' })).toThrow(
      MongoNotConfiguredError,
    );
    expect(() => validateMongoConfig({ uri: 'mongodb://host', dbName: '  ' })).toThrow(
      MongoNotConfiguredError,
    );
  });

  it('returns trimmed values when both are present', () => {
    expect(validateMongoConfig({ uri: '  mongodb://host  ', dbName: ' agentproof ' })).toEqual({
      uri: 'mongodb://host',
      dbName: 'agentproof',
    });
  });
});

// ── Redaction ───────────────────────────────────────────────────────────────

describe('mongo URI redaction', () => {
  it('strips credentials from standard and srv connection strings', () => {
    expect(redactMongoUri('mongodb://user:secret@host:27017/db')).toBe(
      'mongodb://<redacted>@host:27017/db',
    );
    expect(redactMongoUri('mongodb+srv://u:p@cluster.example.net/db')).toBe(
      'mongodb+srv://<redacted>@cluster.example.net/db',
    );
  });

  it('leaves credential-free strings untouched', () => {
    expect(redactMongoUri('mongodb://host:27017/db')).toBe('mongodb://host:27017/db');
  });
});

// ── Connection lifecycle ────────────────────────────────────────────────────

describe('mongo connection lifecycle', () => {
  it('connects once, pings, and returns the database handle', async () => {
    const state = newState();
    const manager = makeManager(state);

    const connection = await manager.connect(validConfig);

    expect(state.factoryCalls).toBe(1);
    expect(state.connectCalls).toBe(1);
    expect(state.pingCalls).toBe(1);
    expect(state.dbNames).toEqual(['agentproof_test']);
    expect(state.lastUri).toBe(validConfig.uri);
    expect(manager.isConnected()).toBe(true);
    expect(manager.getDb()).toBe(connection.db);
    expect(manager.getClient()).toBe(connection.client);
  });

  it('is idempotent: repeated connect() reuses the same client', async () => {
    const state = newState();
    const manager = makeManager(state);

    const a = await manager.connect(validConfig);
    const b = await manager.connect(validConfig);

    expect(state.factoryCalls).toBe(1);
    expect(state.connectCalls).toBe(1);
    expect(a.client).toBe(b.client);
    expect(a.db).toBe(b.db);
  });

  it('shares a single in-flight connection across concurrent callers', async () => {
    const state = newState();
    const manager = makeManager(state);

    const [a, b, c] = await Promise.all([
      manager.connect(validConfig),
      manager.connect(validConfig),
      manager.connect(validConfig),
    ]);

    expect(state.factoryCalls).toBe(1);
    expect(state.connectCalls).toBe(1);
    expect(state.pingCalls).toBe(1);
    expect(a.client).toBe(b.client);
    expect(b.client).toBe(c.client);
  });

  it('throws when the database handle is used before connecting', () => {
    const manager = makeManager(newState());
    expect(() => manager.getDb()).toThrow(MongoConnectionError);
    expect(() => manager.getClient()).toThrow(MongoConnectionError);
  });

  it('close() is idempotent and resets connection state', async () => {
    const state = newState();
    const manager = makeManager(state);

    await manager.connect(validConfig);
    await manager.close();
    await manager.close();

    expect(state.closeCalls).toBe(1);
    expect(manager.isConnected()).toBe(false);
    expect(() => manager.getDb()).toThrow(MongoConnectionError);
  });

  it('closing an unconnected manager is a safe no-op', async () => {
    const state = newState();
    const manager = makeManager(state);
    await expect(manager.close()).resolves.toBeUndefined();
    expect(state.closeCalls).toBe(0);
  });

  it('reconnects with a fresh client after close()', async () => {
    const state = newState();
    const manager = makeManager(state);

    await manager.connect(validConfig);
    await manager.close();
    const again = await manager.connect(validConfig);

    expect(state.factoryCalls).toBe(2);
    expect(manager.isConnected()).toBe(true);
    expect(manager.getDb()).toBe(again.db);
  });

  it('close() during an in-flight connect() does not leak a late connection', async () => {
    const state = newState();
    let resolveConnect: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      resolveConnect = r;
    });
    const manager = new MongoConnectionManager((uri, options) => {
      state.factoryCalls += 1;
      state.lastUri = uri;
      state.lastOptions = options;
      const client = fakeClient(state);
      const realConnect = client.connect.bind(client);
      client.connect = async () => {
        await gate;
        return realConnect();
      };
      return client;
    }, {});

    const pending = manager.connect(validConfig);
    const closing = manager.close();
    resolveConnect!();

    await Promise.all([pending, closing]);

    // The late connect must not leave the manager reporting a live connection.
    expect(manager.isConnected()).toBe(false);
    expect(() => manager.getDb()).toThrow(MongoConnectionError);
    expect(state.closeCalls).toBe(1);
  });

  it('validates configuration when connect() is called without an override', async () => {
    const state = newState();
    const manager = makeManager(state);
    // Empty override must be rejected, not silently accepted.
    await expect(manager.connect({ uri: '', dbName: '' })).rejects.toBeInstanceOf(
      MongoNotConfiguredError,
    );
    expect(state.factoryCalls).toBe(0);
  });
});

// ── Failure handling ────────────────────────────────────────────────────────

describe('mongo connection failures', () => {
  it('reports a failed connect, cleans up the client, and stays disconnected', async () => {
    const state = newState({ failConnect: new Error('ECONNREFUSED') });
    const manager = makeManager(state);

    await expect(manager.connect(validConfig)).rejects.toBeInstanceOf(MongoConnectionError);
    expect(state.connectCalls).toBe(1);
    expect(state.closeCalls).toBe(1); // the half-open client is closed
    expect(manager.isConnected()).toBe(false);
  });

  it('reports a failed ping and cleans up', async () => {
    const state = newState({ failPing: new Error('ping timeout') });
    const manager = makeManager(state);

    const err = await manager.connect(validConfig).catch((e) => e);
    expect(err).toBeInstanceOf(MongoConnectionError);
    expect((err as Error).message).toContain('agentproof_test');
    expect(state.closeCalls).toBe(1);
    expect(manager.isConnected()).toBe(false);
  });

  it('does not leak credentials from a driver error into the failure message', async () => {
    const state = newState({
      failConnect: new Error('failed to parse mongodb://user:supersecret@host/db'),
    });
    const manager = makeManager(state);

    const err = await manager.connect({
      uri: 'mongodb://user:supersecret@host/db',
      dbName: 'agentproof',
    }).catch((e) => e);

    expect(err).toBeInstanceOf(MongoConnectionError);
    expect((err as Error).message).not.toContain('supersecret');
    expect((err as Error).message).toContain('<redacted>');
  });

  it('wraps a synchronous factory failure and still redacts credentials', async () => {
    const manager = new MongoConnectionManager(() => {
      throw new Error(
        'Invalid connection string: mongodb://user:supersecret@host/db',
      );
    }, {});

    const err = await manager
      .connect({ uri: 'mongodb://user:supersecret@host/db', dbName: 'agentproof' })
      .catch((e) => e);

    expect(err).toBeInstanceOf(MongoConnectionError);
    expect((err as Error).message).not.toContain('supersecret');
    expect((err as Error).message).toContain('<redacted>');
    expect(manager.isConnected()).toBe(false);
  });

  it('allows a successful connect after an earlier failure', async () => {
    const state = newState({ failConnect: new Error('transient') });
    const manager = makeManager(state);

    await expect(manager.connect(validConfig)).rejects.toBeInstanceOf(MongoConnectionError);
    state.failConnect = undefined;
    const connection = await manager.connect(validConfig);

    expect(manager.isConnected()).toBe(true);
    expect(manager.getDb()).toBe(connection.db);
  });
});
