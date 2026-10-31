import { describe, it, expect, afterEach } from 'vitest';
import {
  InvalidPersistenceProviderError,
  resolvePersistenceProvider,
} from './persistenceProvider.js';
import {
  getIntentRepository,
  getProductRepository,
  getSelectionRepository,
  getSessionRepository,
  getTransactionRepository,
  getUserRepository,
  getPersistenceProvider,
  setMongoDb,
  setPersistenceProvider,
  setRepositoryOverrides,
  resetMongoDb,
  PersistenceNotReadyError,
} from './repositories.js';
import { MongoIntentRepository } from '../services/intent/MongoIntentRepository.js';
import { MongoProductRepository } from '../services/discovery/MongoProductRepository.js';
import { MongoSelectionRepository } from '../services/selection/MongoSelectionRepository.js';
import { MongoTransactionRepository } from '../services/transactions/MongoTransactionRepository.js';
import { MongoUserRepository } from '../services/auth/MongoUserRepository.js';
import { MongoSessionRepository } from '../services/auth/MongoSessionRepository.js';
import { createFakeDb } from '../test/fakeMongo.js';

/**
 * Provider selection and fail-closed composition behavior. No Atlas connection:
 * the fake Db stands in for a connected cluster, and configuration is passed
 * explicitly instead of via process.env.
 */

afterEach(() => {
  setPersistenceProvider(null);
  resetMongoDb();
});

describe('resolvePersistenceProvider', () => {
  it('defaults to sqlite when unset or empty', () => {
    expect(resolvePersistenceProvider('')).toBe('sqlite');
    expect(resolvePersistenceProvider('   ')).toBe('sqlite');
  });

  it('accepts the supported values (trimmed, case-insensitive)', () => {
    expect(resolvePersistenceProvider('sqlite')).toBe('sqlite');
    expect(resolvePersistenceProvider('mongodb')).toBe('mongodb');
    expect(resolvePersistenceProvider(' MongoDB ')).toBe('mongodb');
  });

  it('rejects an unsupported value instead of coercing to a default', () => {
    expect(() => resolvePersistenceProvider('postgres')).toThrow(InvalidPersistenceProviderError);
    expect(() => resolvePersistenceProvider('sqlite2')).toThrow(/no automatic fallback/i);
  });
});

describe('composition root provider selection', () => {
  it('selects the sqlite provider by default (no MongoDB adapter is constructed)', () => {
    setPersistenceProvider(null);
    // No DB is initialized in this unit test, so the sqlite accessor would need
    // getDb(). Assert the selection decision rather than constructing it.
    expect(getPersistenceProvider()).toBe('sqlite');
  });

  it('returns MongoDB adapters when mongodb is selected and a handle is bound', () => {
    setPersistenceProvider('mongodb');
    setMongoDb(createFakeDb());
    expect(getTransactionRepository()).toBeInstanceOf(MongoTransactionRepository);
    expect(getIntentRepository()).toBeInstanceOf(MongoIntentRepository);
    expect(getProductRepository()).toBeInstanceOf(MongoProductRepository);
    expect(getUserRepository()).toBeInstanceOf(MongoUserRepository);
    expect(getSessionRepository()).toBeInstanceOf(MongoSessionRepository);
    expect(getSelectionRepository()).toBeInstanceOf(MongoSelectionRepository);
  });

  it('fails closed when mongodb is selected but no handle is bound (no SQLite fallback)', () => {
    setPersistenceProvider('mongodb');
    expect(() => getTransactionRepository()).toThrow(PersistenceNotReadyError);
    expect(() => getIntentRepository()).toThrow(/no automatic fallback/i);
    expect(() => getProductRepository()).toThrow(/no automatic fallback/i);
    expect(() => getUserRepository()).toThrow(/no automatic fallback/i);
    expect(() => getSessionRepository()).toThrow(/no automatic fallback/i);
    expect(() => getSelectionRepository()).toThrow(/no automatic fallback/i);
  });

  it('uses the injected override regardless of provider', () => {
    setPersistenceProvider('mongodb');
    const stub = { insertPending: async () => {}, getById: async () => null, getByIdForUser: async () => null, getByPaypalOrderId: async () => null, getByPaypalOrderIdForUser: async () => null, listForUser: async () => [], completePayment: async () => ({ kind: 'NOT_FOUND' as const }) };
    setRepositoryOverrides({ transaction: stub });
    try {
      expect(getTransactionRepository()).toBe(stub);
    } finally {
      setRepositoryOverrides({});
    }
  });
});
