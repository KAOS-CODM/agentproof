import type { Db } from 'mongodb';
import { getDb } from '../models/db.js';
import { resolvePersistenceProvider, type PersistenceProvider } from '../models/persistenceProvider.js';
import { SQLiteIntentRepository } from '../services/intent/SQLiteIntentRepository.js';
import { MongoIntentRepository } from '../services/intent/MongoIntentRepository.js';
import { SQLitePolicyEvaluationRepository } from '../services/policy/SQLitePolicyEvaluationRepository.js';
import { MongoPolicyEvaluationRepository } from '../services/policy/MongoPolicyEvaluationRepository.js';
import { SQLiteEvidenceRepository } from '../services/evidence/SQLiteEvidenceRepository.js';
import { MongoEvidenceRepository } from '../services/evidence/MongoEvidenceRepository.js';
import { SQLiteProductRepository } from '../services/discovery/SQLiteProductRepository.js';
import { MongoProductRepository } from '../services/discovery/MongoProductRepository.js';
import { SQLiteTransactionRepository } from '../services/transactions/SQLiteTransactionRepository.js';
import { MongoTransactionRepository } from '../services/transactions/MongoTransactionRepository.js';
import { SQLiteUserRepository } from '../services/auth/SQLiteUserRepository.js';
import { MongoUserRepository } from '../services/auth/MongoUserRepository.js';
import { SQLiteSessionRepository } from '../services/auth/SQLiteSessionRepository.js';
import { MongoSessionRepository } from '../services/auth/MongoSessionRepository.js';
import { SQLiteSelectionRepository } from '../services/selection/SQLiteSelectionRepository.js';
import { MongoSelectionRepository } from '../services/selection/MongoSelectionRepository.js';
import { EvidenceService } from '../services/evidence/EvidenceService.js';
import { AIService, type RecommendableAIService } from '../services/ai/AIService.js';
import { ProductDiscoveryService, type ProductSource } from '../services/discovery/ProductDiscoveryService.js';
import { createDiscoverySource } from '../services/discovery/discoverySource.js';
import type { IntentRepository } from '../services/intent/IntentRepository.js';
import type { PolicyEvaluationRepository } from '../services/policy/PolicyEvaluationRepository.js';
import type { ProductRepository } from '../services/discovery/ProductRepository.js';
import type { EvidenceRepository } from '../services/evidence/EvidenceRepository.js';
import type { TransactionRepository } from '../services/transactions/TransactionRepository.js';
import type { UserRepository } from '../services/auth/UserRepository.js';
import type { SessionRepository } from '../services/auth/SessionRepository.js';
import type { SelectionRepository } from '../services/selection/SelectionRepository.js';

/**
 * Composition root for the persistence layer (P1a, provider-aware in P2-B).
 *
 * Routes ask this module for repository interfaces; they never construct a
 * backend-specific adapter themselves. The adapter set is chosen from
 * `PERSISTENCE_PROVIDER`:
 *
 *   - `sqlite` (default) — every accessor returns the sql.js adapter resolved
 *     lazily via `getDb()`.
 *   - `mongodb` — intent, policy-evaluation, evidence, transaction, shared
 *     offer, per-intent discovery, user, session, and selection accessors return
 *     MongoDB adapters bound to the connected `Db`. The product accessor is the
 *     P3 facade over the `offers` and `intentDiscoveries` collections.
 *
 * Lifecycle: nothing connects here. In MongoDB mode the startup path must call
 * `setMongoDb(db)` after `connectMongo()` + `ensureIndexes()` for P2-B, P3, P4,
 * P5, and P6. Before that, a MongoDB-backed accessor throws a clear
 * `PersistenceNotReadyError` — it never silently falls back to SQLite.
 *
 * The optional `setRepositoryOverrides` hook exists solely so tests can inject
 * in-memory repositories and provider stubs without bootstrapping any database
 * or making live provider calls. Production code never calls it.
 */

/** Thrown when a MongoDB-backed accessor is used before startup connected it. */
export class PersistenceNotReadyError extends Error {
  constructor(repository: string) {
    super(
      `${repository} is MongoDB-backed but MongoDB is not connected. The startup ` +
        `path must connect and call setMongoDb() before serving requests. There is ` +
        `no automatic fallback to SQLite.`,
    );
    this.name = 'PersistenceNotReadyError';
  }
}

export interface RepositoryOverrides {
  intent?: IntentRepository;
  policyEvaluation?: PolicyEvaluationRepository;
  product?: ProductRepository;
  evidence?: EvidenceRepository;
  transaction?: TransactionRepository;
  user?: UserRepository;
  session?: SessionRepository;
  /** Durable offer selection store (P6 schema, populated from P2 onward). */
  selection?: SelectionRepository;
  /** AI recommender used by the discovery flow. */
  ai?: RecommendableAIService;
  /** Product discovery source used by the discovery flow. */
  discoverySource?: ProductSource;
  /** AI intent parser used by the intent route. */
  intentParser?: Pick<AIService, 'parseIntent'>;
}

let overrides: RepositoryOverrides = {};
let mongoDb: Db | null = null;
let providerOverride: PersistenceProvider | null = null;

export function setRepositoryOverrides(next: RepositoryOverrides): void {
  overrides = next;
}

/** The currently selected persistence provider (overridable for tests). */
export function getPersistenceProvider(): PersistenceProvider {
  return providerOverride ?? resolvePersistenceProvider();
}

/**
 * Bind the connected MongoDB handle used by the MongoDB adapters. Called once
 * by the startup path after a successful connect + index initialization.
 */
export function setMongoDb(db: Db): void {
  mongoDb = db;
}

/** Test-only: force a provider without touching process.env. */
export function setPersistenceProvider(provider: PersistenceProvider | null): void {
  providerOverride = provider;
}

/** Test-only: reset the bound Mongo handle. */
export function resetMongoDb(): void {
  mongoDb = null;
}

function requireMongoDb(repository: string): Db {
  if (!mongoDb) throw new PersistenceNotReadyError(repository);
  return mongoDb;
}

export function getIntentRepository(): IntentRepository {
  if (overrides.intent) return overrides.intent;
  if (getPersistenceProvider() === 'mongodb') {
    return new MongoIntentRepository(requireMongoDb('IntentRepository'));
  }
  return new SQLiteIntentRepository(getDb());
}

export function getPolicyEvaluationRepository(): PolicyEvaluationRepository {
  if (overrides.policyEvaluation) return overrides.policyEvaluation;
  if (getPersistenceProvider() === 'mongodb') {
    return new MongoPolicyEvaluationRepository(requireMongoDb('PolicyEvaluationRepository'));
  }
  return new SQLitePolicyEvaluationRepository(getDb());
}

/**
 * Product/discovery repository. MongoDB mode uses the shared `offers` +
 * per-intent `intentDiscoveries` collections; SQLite mode keeps the sql.js
 * adapter. There is no hybrid or automatic fallback.
 */
export function getProductRepository(): ProductRepository {
  if (overrides.product) return overrides.product;
  if (getPersistenceProvider() === 'mongodb') {
    return new MongoProductRepository(requireMongoDb('ProductRepository'));
  }
  return new SQLiteProductRepository(getDb());
}

export function getEvidenceRepository(): EvidenceRepository {
  if (overrides.evidence) return overrides.evidence;
  if (getPersistenceProvider() === 'mongodb') {
    return new MongoEvidenceRepository(requireMongoDb('EvidenceRepository'));
  }
  return new SQLiteEvidenceRepository(getDb());
}

export function getTransactionRepository(): TransactionRepository {
  if (overrides.transaction) return overrides.transaction;
  if (getPersistenceProvider() === 'mongodb') {
    return new MongoTransactionRepository(requireMongoDb('TransactionRepository'));
  }
  return new SQLiteTransactionRepository(getDb());
}

/**
 * Account storage used by the P5 login/session middleware. There is still no
 * public registration path; accounts are provisioned by the operator.
 */
export function getUserRepository(): UserRepository {
  if (overrides.user) return overrides.user;
  if (getPersistenceProvider() === 'mongodb') {
    return new MongoUserRepository(requireMongoDb('UserRepository'));
  }
  return new SQLiteUserRepository(getDb());
}

/**
 * Server-side session storage used by the P5 auth middleware and login/logout
 * routes. Only token hashes are persisted.
 */
export function getSessionRepository(): SessionRepository {
  if (overrides.session) return overrides.session;
  if (getPersistenceProvider() === 'mongodb') {
    return new MongoSessionRepository(requireMongoDb('SessionRepository'));
  }
  return new SQLiteSessionRepository(getDb());
}

/**
 * The user's durable offer selection. Backs the picker so a later approval and
 * order can be bound to the exact immutable snapshot the user chose, rather than
 * to whatever the shared offer row happens to say when the order is created.
 */
export function getSelectionRepository(): SelectionRepository {
  if (overrides.selection) return overrides.selection;
  if (getPersistenceProvider() === 'mongodb') {
    return new MongoSelectionRepository(requireMongoDb('SelectionRepository'));
  }
  return new SQLiteSelectionRepository(getDb());
}

/** Evidence service bound to the active evidence repository. */
export function getEvidenceService(): EvidenceService {
  return new EvidenceService(getEvidenceRepository());
}

/**
 * AI recommender for the discovery flow. Resolved per call so tests can inject
 * a stub and so the live service is only constructed when it is actually used.
 */
export function getAIService(): RecommendableAIService {
  return overrides.ai ?? new AIService();
}

/** Product discovery service bound to the active (or injected) source. */
export function getDiscoveryService(): ProductDiscoveryService {
  return new ProductDiscoveryService(overrides.discoverySource ?? createDiscoverySource());
}

/** AI intent parser for the intent route. Injectable for tests. */
export function getIntentParser(): Pick<AIService, 'parseIntent'> {
  return overrides.intentParser ?? new AIService();
}
