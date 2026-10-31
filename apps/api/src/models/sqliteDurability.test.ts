import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';
import type { EvidenceRecord } from '@agentproof/shared';
import { AuthService } from '../services/auth/AuthService.js';
import type { PersistedIntent } from '../services/intent/IntentRepository.js';
import type { PersistedTransaction } from '../services/transactions/TransactionRepository.js';
import {
  getEvidenceRepository,
  getIntentRepository,
  getSessionRepository,
  getTransactionRepository,
  getUserRepository,
  setPersistenceProvider,
} from './repositories.js';
import { initializePersistence } from './startup.js';
import { closeDb, getDb, initDb } from './db.js';

const require = createRequire(import.meta.url);

const testConfig = vi.hoisted(() => ({
  dbPath: '',
  authInitialEmail: null as string | null,
  authInitialPassword: null as string | null,
  authSessionTtlMs: 60_000,
  persistenceProvider: 'sqlite',
}));

// The durability suite deliberately avoids loading the repository's real .env.
vi.mock('../config/env.js', () => ({ config: testConfig }));

let tempDir = '';
let dbPath = '';

const intent: PersistedIntent = {
  id: 'intent-durable',
  userId: 'user-durable',
  rawInput: 'Buy durable test shoes',
  structured: {
    purpose: 'running shoes',
    maxAmount: 150,
    currency: 'USD',
    brands: [],
    condition: 'any',
    requiresConfirmationAbove: null,
    constraints: [],
  },
  status: 'VALIDATED',
  createdAt: '2026-10-20T10:00:00.000Z',
  parsedAt: '2026-10-20T10:00:00.000Z',
  validatedAt: '2026-10-20T10:00:00.000Z',
};

const transaction: PersistedTransaction = {
  id: 'tx-durable',
  userId: 'user-durable',
  intentId: intent.id,
  productId: 'demo:durable-shoe',
  policyEvaluationId: 'pe-durable',
  paypalOrderId: 'O-DURABLE',
  paypalCaptureId: null,
  amount: 44.95,
  currency: 'USD',
  financialState: 'PAYMENT_PENDING',
  createdAt: '2026-10-20T10:01:00.000Z',
  updatedAt: '2026-10-20T10:01:00.000Z',
};

const evidence: EvidenceRecord = {
  id: 'ev-durable',
  eventType: 'INTENT_CREATED',
  timestamp: '2026-10-20T10:00:00.000Z',
  actor: 'user',
  transactionId: transaction.id,
  intentId: intent.id,
  approvalRequestId: null,
  policyEvaluationId: null,
  data: { source: 'durability-test' },
  metadata: { source: 'user_input', correlationId: 'durability-test' },
};

async function openProbe() {
  const SQL = await initSqlJs({
    locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm'),
  });
  return new SQL.Database(readFileSync(dbPath));
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'agentproof-sqlite-durability-'));
  dbPath = join(tempDir, 'agentproof.db');
  testConfig.dbPath = dbPath;
  testConfig.authInitialEmail = null;
  testConfig.authInitialPassword = null;
  setPersistenceProvider('sqlite');
});

afterEach(() => {
  try {
    closeDb();
  } finally {
    setPersistenceProvider(null);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('SQLite durability lifecycle', () => {
  it('creates a new database file and can reopen it', async () => {
    const first = await initializePersistence('sqlite');
    expect(existsSync(dbPath)).toBe(true);
    expect(statSync(dbPath).size).toBeGreaterThan(0);

    await first.close();
    expect(() => getDb()).toThrow(/not initialized/i);

    const second = await initializePersistence('sqlite');
    const tables = getDb().exec(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'",
    );
    expect(tables[0]?.values).toHaveLength(1);
    await second.close();
  });

  it('persists each successful mutation before shutdown', async () => {
    const persistence = await initializePersistence('sqlite');
    await getIntentRepository().create(intent);

    // Read the on-disk file while the process is still running, proving that
    // persistence is not deferred until closeDb().
    const probe = await openProbe();
    try {
      const rows = probe.exec('SELECT id, user_id FROM intents');
      expect(rows[0]?.values).toEqual([['intent-durable', 'user-durable']]);
    } finally {
      probe.close();
    }

    expect(readdirSync(tempDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    await persistence.close();
  });

  it('loads saved intents, transactions, and evidence after a restart', async () => {
    const first = await initializePersistence('sqlite');
    await getIntentRepository().create(intent);
    await getTransactionRepository().insertPending(transaction);
    await getEvidenceRepository().append(evidence, intent.userId ?? null);
    await first.close();

    const second = await initializePersistence('sqlite');
    try {
      expect(
        await getIntentRepository().getByIdForUser(intent.id, 'user-durable'),
      ).toMatchObject({ id: intent.id, rawInput: intent.rawInput });
      expect(
        await getTransactionRepository().getByIdForUser(transaction.id, 'user-durable'),
      ).toMatchObject({ id: transaction.id, financialState: 'PAYMENT_PENDING' });
      expect(
        await getEvidenceRepository().getByTransactionIdForUser(
          transaction.id,
          'user-durable',
        ),
      ).toHaveLength(1);
    } finally {
      await second.close();
    }
  });

  it('does not reset an existing provisioned user password after restart', async () => {
    testConfig.authInitialEmail = '  Durable@Example.COM ';
    testConfig.authInitialPassword = 'first-password-123';

    const first = await initializePersistence('sqlite');
    const firstUser = await getUserRepository().getByEmail('durable@example.com');
    expect(firstUser).not.toBeNull();

    const firstAuth = new AuthService({
      users: getUserRepository(),
      sessions: getSessionRepository(),
      sessionTtlMs: testConfig.authSessionTtlMs,
    });
    expect(await firstAuth.login('durable@example.com', 'first-password-123')).not.toBeNull();
    await first.close();

    // Simulate an operator changing the bootstrap password in .env. Provisioning
    // must find the durable account and leave its existing hash untouched.
    testConfig.authInitialPassword = 'second-password-456';

    const second = await initializePersistence('sqlite');
    try {
      const secondUser = await getUserRepository().getByEmail('durable@example.com');
      expect(secondUser?.id).toBe(firstUser?.id);

      const secondAuth = new AuthService({
        users: getUserRepository(),
        sessions: getSessionRepository(),
        sessionTtlMs: testConfig.authSessionTtlMs,
      });
      expect(
        await secondAuth.login('durable@example.com', 'first-password-123'),
      ).not.toBeNull();
      expect(await secondAuth.login('durable@example.com', 'second-password-456')).toBeNull();
    } finally {
      await second.close();
    }
  });

  it('refuses to overwrite a corrupt existing database file', async () => {
    const original = Buffer.from('not a sqlite database');
    writeFileSync(dbPath, original);

    await expect(initDb()).rejects.toThrow(/Failed to open existing SQLite database/);
    expect(readFileSync(dbPath).equals(original)).toBe(true);
  });

  it('refuses to treat an empty existing file as a new database', async () => {
    writeFileSync(dbPath, Buffer.alloc(0));

    await expect(initDb()).rejects.toThrow(/empty SQLite database file/);
    expect(statSync(dbPath).size).toBe(0);
  });
});
