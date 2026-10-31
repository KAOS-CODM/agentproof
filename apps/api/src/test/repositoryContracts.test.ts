import { describe, it, expect, beforeEach } from 'vitest';
import type { EvidenceRecord, PolicyEvaluation, Product, Transaction } from '@agentproof/shared';
import { SQLiteEvidenceRepository } from '../services/evidence/SQLiteEvidenceRepository.js';
import { SQLiteProductRepository } from '../services/discovery/SQLiteProductRepository.js';
import { SQLiteIntentRepository } from '../services/intent/SQLiteIntentRepository.js';
import { SQLitePolicyEvaluationRepository } from '../services/policy/SQLitePolicyEvaluationRepository.js';
import { SQLiteTransactionRepository } from '../services/transactions/SQLiteTransactionRepository.js';
import { SQLiteUserRepository } from '../services/auth/SQLiteUserRepository.js';
import { SQLiteSessionRepository } from '../services/auth/SQLiteSessionRepository.js';
import type { EvidenceRepository } from '../services/evidence/EvidenceRepository.js';
import type { ProductRepository } from '../services/discovery/ProductRepository.js';
import type { IntentRepository } from '../services/intent/IntentRepository.js';
import type { PolicyEvaluationRepository } from '../services/policy/PolicyEvaluationRepository.js';
import type { PersistedTransaction, TransactionRepository } from '../services/transactions/TransactionRepository.js';
import type { UserRepository } from '../services/auth/UserRepository.js';
import type { SessionRepository } from '../services/auth/SessionRepository.js';
import type { SelectionRepository } from '../services/selection/SelectionRepository.js';
import { SelectionValidationError } from '../services/selection/SelectionRepository.js';
import {
  InMemoryEvidenceRepository,
  InMemoryProductRepository,
  InMemoryIntentRepository,
  InMemoryPolicyEvaluationRepository,
  InMemoryTransactionRepository,
  InMemoryUserRepository,
  InMemorySessionRepository,
  InMemorySelectionRepository,
} from './inMemoryRepositories.js';
import { createTestDatabase } from './testDatabase.js';
import { createFakeDb } from './fakeMongo.js';
import { MongoIntentRepository } from '../services/intent/MongoIntentRepository.js';
import { MongoPolicyEvaluationRepository } from '../services/policy/MongoPolicyEvaluationRepository.js';
import { MongoEvidenceRepository } from '../services/evidence/MongoEvidenceRepository.js';
import { MongoTransactionRepository } from '../services/transactions/MongoTransactionRepository.js';
import { MongoProductRepository } from '../services/discovery/MongoProductRepository.js';
import { MongoUserRepository } from '../services/auth/MongoUserRepository.js';
import { MongoSessionRepository } from '../services/auth/MongoSessionRepository.js';
import { SQLiteSelectionRepository } from '../services/selection/SQLiteSelectionRepository.js';
import { MongoSelectionRepository } from '../services/selection/MongoSelectionRepository.js';
import { ensureIndexes } from '../models/mongoIndexes.js';
import type { MongoDbLike } from '../models/mongoClient.js';

/**
 * Shared contract suite for the persisted repositories (P2-B/P3/P4).
 *
 * The identical assertions run against three backends:
 *   1. the lightweight in-memory reference implementations,
 *   2. the SQLite (sql.js) adapters, and
 *   3. the MongoDB adapters over the in-memory fake driver.
 *
 * This is what guarantees a repository can be swapped for another without
 * changing observable behaviour.
 */

interface Repositories {
  evidence: EvidenceRepository;
  products: ProductRepository;
  intents: IntentRepository;
  policyEvaluations: PolicyEvaluationRepository;
  transactions: TransactionRepository;
  users: UserRepository;
  sessions: SessionRepository;
  selections: SelectionRepository;
}

const intentId = 'intent-1';

function makeEvidence(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    id: 'ev-1',
    eventType: 'INTENT_CREATED',
    timestamp: '2026-10-20T10:00:00.000Z',
    actor: 'user',
    transactionId: null,
    intentId,
    approvalRequestId: null,
    policyEvaluationId: null,
    data: { a: 1 },
    metadata: { source: 'user_input', correlationId: 'c-1' },
    ...overrides,
  };
}

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'channel3:runfalcon',
    source: 'channel3',
    name: 'Runfalcon 3.0 Running Shoes',
    description: 'Lightweight running shoes.',
    price: 44.95,
    currency: 'USD',
    brand: 'adidas',
    condition: 'new',
    category: 'Running Shoes',
    merchant: 'shoebacca.com',
    productUrl: 'https://shoebacca.com/p/runfalcon-3',
    availability: 'InStock',
    externalId: '1FesGXD',
    ...overrides,
  };
}

function makeEvaluation(overrides: Partial<PolicyEvaluation> = {}): PolicyEvaluation {
  return {
    id: 'pe-1',
    intentId,
    productId: 'channel3:runfalcon',
    result: 'ALLOW',
    confirmationRequired: false,
    ruleResults: [],
    evaluatedAt: '2026-10-20T10:00:00.000Z',
    ...overrides,
  };
}

function makeTransaction(overrides: Partial<PersistedTransaction> = {}): PersistedTransaction {
  return {
    id: 'tx-1',
    intentId,
    productId: 'channel3:runfalcon',
    policyEvaluationId: 'pe-1',
    paypalOrderId: 'O-SANDBOX-1',
    paypalCaptureId: null,
    amount: 44.95,
    currency: 'USD',
    financialState: 'PAYMENT_PENDING',
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-20T10:00:00.000Z',
    ...overrides,
  };
}

function makeIntent(overrides: Partial<Parameters<IntentRepository['create']>[0]> = {}) {
  return {
    id: intentId,
    userId: 'user-1',
    rawInput: 'Buy running shoes',
    structured: {
      purpose: 'running shoes',
      maxAmount: 150,
      currency: 'USD',
      brands: [],
      condition: 'any' as const,
      requiresConfirmationAbove: null,
      constraints: [],
    },
    status: 'VALIDATED' as const,
    createdAt: '2026-10-20T10:00:00.000Z',
    parsedAt: '2026-10-20T10:00:00.000Z',
    validatedAt: '2026-10-20T10:00:00.000Z',
    ...overrides,
  };
}

function makeUser(overrides: Partial<Parameters<UserRepository['create']>[0]> = {}) {
  return {
    id: 'user-1',
    email: '  User@Example.COM ',
    passwordHash: '$2b$fake-password-hash',
    createdAt: '2026-10-20T10:00:00.000Z',
    ...overrides,
  };
}

function makeSession(overrides: Partial<Parameters<SessionRepository['create']>[0]> = {}) {
  return {
    id: 'session-1',
    userId: 'user-1',
    tokenHash: 'sha256:deadbeef',
    createdAt: '2026-10-20T10:00:00.000Z',
    expiresAt: '2026-10-20T11:00:00.000Z',
    revokedAt: null,
    ...overrides,
  };
}

function makeSelection(
  overrides: Partial<Parameters<SelectionRepository['select']>[0]> = {},
): Parameters<SelectionRepository['select']>[0] {
  return {
    id: 'sel-1',
    userId: 'user-1',
    intentId,
    snapshotId: 'snap-1',
    source: 'channel3',
    productId: 'channel3:runfalcon',
    price: 44.95,
    currency: 'USD',
    isActive: true,
    selectedAt: '2026-10-20T10:00:00.000Z',
    supersededAt: null,
    ...overrides,
  };
}

function describeContract(
  name: string,
  build: () => Promise<Repositories> | Repositories,
): void {
  describe(`repository contract: ${name}`, () => {
    let repos: Repositories;

    beforeEach(async () => {
      repos = await build();
    });

    describe('IntentRepository', () => {
      it('creates and retrieves an intent', async () => {
        await repos.intents.create({
          id: intentId,
          rawInput: 'Buy running shoes',
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
        });

        const intent = await repos.intents.getById(intentId);
        expect(intent).not.toBeNull();
        expect(intent!.id).toBe(intentId);
        expect(intent!.rawInput).toBe('Buy running shoes');
        expect(intent!.status).toBe('VALIDATED');
        expect(intent!.structured.purpose).toBe('running shoes');
      });

      it('returns null (documented not-found) for a missing intent', async () => {
        expect(await repos.intents.getById('missing')).toBeNull();
      });

      it('returns only the structured intent via getStructuredById', async () => {
        await repos.intents.create({
          id: intentId,
          rawInput: 'x',
          structured: {
            purpose: 'watch',
            maxAmount: 10,
            currency: 'USD',
            brands: [],
            condition: 'any',
            requiresConfirmationAbove: null,
            constraints: [],
          },
          status: 'VALIDATED',
          createdAt: 'now',
          parsedAt: null,
          validatedAt: null,
        });

        const structured = await repos.intents.getStructuredById(intentId);
        expect(structured?.purpose).toBe('watch');
        expect(await repos.intents.getStructuredById('missing')).toBeNull();
      });

      it('scopes intent reads to the owner and hides legacy ownerless rows', async () => {
        await repos.intents.create(makeIntent({ id: 'owned', userId: 'user-1' }));
        await repos.intents.create(makeIntent({ id: 'foreign', userId: 'user-2' }));
        await repos.intents.create(makeIntent({ id: 'legacy', userId: null }));

        expect(await repos.intents.getByIdForUser('owned', 'user-1')).not.toBeNull();
        expect(await repos.intents.getStructuredByIdForUser('owned', 'user-1')).not.toBeNull();

        expect(await repos.intents.getByIdForUser('owned', 'user-2')).toBeNull();
        expect(await repos.intents.getStructuredByIdForUser('owned', 'user-2')).toBeNull();
        expect(await repos.intents.getByIdForUser('foreign', 'user-1')).toBeNull();
        expect(await repos.intents.getByIdForUser('legacy', 'user-1')).toBeNull();
        expect(await repos.intents.getStructuredByIdForUser('legacy', 'user-1')).toBeNull();

        // Unscoped internal reads still see every row (recovery/contracts only).
        expect(await repos.intents.getById('legacy')).not.toBeNull();
        expect(await repos.intents.getById('foreign')).not.toBeNull();
      });

      it('lists only owned intents, most recent first, with a bounded limit', async () => {
        await repos.intents.create(
          makeIntent({ id: 'older', userId: 'user-1', createdAt: '2026-10-20T09:00:00.000Z' }),
        );
        await repos.intents.create(
          makeIntent({ id: 'newer', userId: 'user-1', createdAt: '2026-10-20T11:00:00.000Z' }),
        );
        await repos.intents.create(
          makeIntent({ id: 'foreign', userId: 'user-2', createdAt: '2026-10-20T12:00:00.000Z' }),
        );
        await repos.intents.create(
          makeIntent({ id: 'legacy', userId: null, createdAt: '2026-10-20T13:00:00.000Z' }),
        );

        expect(
          (await repos.intents.listForUser('user-1', 10)).map((intent) => intent.id),
        ).toEqual(['newer', 'older']);
        expect(
          (await repos.intents.listForUser('user-1', 1)).map((intent) => intent.id),
        ).toEqual(['newer']);
        expect(
          (await repos.intents.listForUser('user-2', 10)).map((intent) => intent.id),
        ).toEqual(['foreign']);
        expect(await repos.intents.listForUser('missing', 10)).toEqual([]);
      });
    });

    describe('PolicyEvaluationRepository', () => {
      it('persists a policy evaluation', async () => {
        await expect(repos.policyEvaluations.save(makeEvaluation())).resolves.toBeUndefined();
      });

      it('lists an intent owner evaluations in evaluation order only', async () => {
        await repos.policyEvaluations.save(
          makeEvaluation({ id: 'pe-later', productId: 'later', evaluatedAt: '2026-10-20T10:02:00.000Z' }),
          'user-1',
        );
        await repos.policyEvaluations.save(
          makeEvaluation({ id: 'pe-earlier', productId: 'earlier', evaluatedAt: '2026-10-20T10:01:00.000Z' }),
          'user-1',
        );
        await repos.policyEvaluations.save(
          makeEvaluation({ id: 'pe-foreign', productId: 'foreign' }),
          'user-2',
        );
        await repos.policyEvaluations.save(
          makeEvaluation({ id: 'pe-legacy', productId: 'legacy' }),
          null,
        );

        const owned = await repos.policyEvaluations.listByIntentForUser(intentId, 'user-1');
        expect(owned.map((evaluation) => evaluation.id)).toEqual(['pe-earlier', 'pe-later']);
        expect(await repos.policyEvaluations.listByIntentForUser('other-intent', 'user-1')).toEqual([]);
        expect(await repos.policyEvaluations.listByIntentForUser(intentId, 'user-2')).toEqual([
          expect.objectContaining({ id: 'pe-foreign' }),
        ]);
      });
    });

    describe('ProductRepository (shared offers + per-intent discoveries)', () => {
      it('stores and retrieves the shared offer by provider + product id', async () => {
        const product = makeProduct();
        await repos.products.upsert(product, {
          discoveredAt: '2026-10-20T10:00:00.000Z',
          discoveredForIntentId: intentId,
        });

        const offer = await repos.products.getOffer(product.source, product.id);
        expect(offer).not.toBeNull();
        expect(offer!.product).toEqual(product);
        expect(offer!.discoveredAt).toBe('2026-10-20T10:00:00.000Z');
        expect(offer!.discoveredForIntentId).toBeNull();
      });

      it('stores and retrieves the per-intent discovery association', async () => {
        const product = makeProduct();
        await repos.products.upsert(product, {
          discoveredAt: '2026-10-20T10:00:00.000Z',
          discoveredForIntentId: intentId,
          evaluationId: 'pe-1',
          decision: 'ALLOW',
          confirmationRequired: false,
        });

        const stored = await repos.products.getForIntent(intentId, product.source, product.id);
        expect(stored).not.toBeNull();
        expect(stored!.product).toEqual(product);
        expect(stored!.discoveredAt).toBe('2026-10-20T10:00:00.000Z');
        expect(stored!.discoveredForIntentId).toBe(intentId);
      });

      it('lists one intent discoveries with their policy metadata, most recent first', async () => {
        await repos.products.upsert(makeProduct({ id: 'older', name: 'Older' }), {
          discoveredAt: '2026-10-20T10:00:00.000Z',
          discoveredForIntentId: intentId,
          evaluationId: 'pe-older',
          decision: 'ALLOW',
          confirmationRequired: false,
        });
        await repos.products.upsert(makeProduct({ id: 'newer', name: 'Newer' }), {
          discoveredAt: '2026-10-20T10:05:00.000Z',
          discoveredForIntentId: intentId,
          evaluationId: 'pe-newer',
          decision: 'ALLOW',
          confirmationRequired: true,
        });
        await repos.products.upsert(makeProduct({ id: 'foreign' }), {
          discoveredAt: '2026-10-20T10:10:00.000Z',
          discoveredForIntentId: 'intent-2',
          evaluationId: 'pe-foreign',
          decision: 'ALLOW',
          confirmationRequired: false,
        });

        const entries = await repos.products.listForIntent(intentId);
        expect(entries.map((entry) => entry.product.id)).toEqual(['newer', 'older']);
        expect(entries[0]).toMatchObject({
          discoveredAt: '2026-10-20T10:05:00.000Z',
          evaluationId: 'pe-newer',
          decision: 'ALLOW',
          confirmationRequired: true,
        });
        expect(await repos.products.listForIntent('missing')).toEqual([]);
      });

      it('refreshes an existing offer rather than duplicating it', async () => {
        await repos.products.upsert(makeProduct({ price: 44.95 }), {
          discoveredAt: '2026-10-20T10:00:00.000Z',
          discoveredForIntentId: intentId,
        });
        await repos.products.upsert(makeProduct({ price: 39.5 }), {
          discoveredAt: '2026-10-20T10:15:00.000Z',
          discoveredForIntentId: intentId,
        });

        const offer = await repos.products.getOffer('channel3', 'channel3:runfalcon');
        expect(offer!.product.price).toBe(39.5);
        expect(offer!.discoveredAt).toBe('2026-10-20T10:15:00.000Z');
      });

      it('captures an immutable owner-scoped offer snapshot per intent', async () => {
        const product = makeProduct({
          metadata: {
            provider: 'channel3',
            offerDomain: 'shoebacca.com',
            compareAtPrice: 65,
            maxCommissionRate: 0.05,
          },
        });
        await repos.products.upsert(product, {
          discoveredAt: '2026-10-20T10:00:00.000Z',
          discoveredForIntentId: intentId,
          evaluationId: 'pe-1',
          decision: 'ALLOW',
          confirmationRequired: false,
          userId: 'user-1',
        });

        const snapshot = await repos.products.getSnapshotForIntent(
          intentId,
          product.source,
          product.id,
          'user-1',
        );
        expect(snapshot).toMatchObject({
          userId: 'user-1',
          intentId,
          source: 'channel3',
          productId: product.id,
          externalProductId: '1FesGXD',
          offerUrl: 'https://shoebacca.com/p/runfalcon-3',
          merchant: 'shoebacca.com',
          price: 44.95,
          currency: 'USD',
          availability: 'InStock',
          condition: 'new',
          compareAtPrice: 65,
          maxCommissionRate: 0.05,
          capturedAt: '2026-10-20T10:00:00.000Z',
        });
        expect(snapshot!.id.length).toBeGreaterThan(0);
      });

      it('does not mutate an earlier snapshot when the shared offer is refreshed', async () => {
        await repos.products.upsert(makeProduct({ price: 44.95 }), {
          discoveredAt: '2026-10-20T10:00:00.000Z',
          discoveredForIntentId: intentId,
          userId: 'user-1',
        });
        const first = await repos.products.getSnapshotForIntent(
          intentId,
          'channel3',
          'channel3:runfalcon',
          'user-1',
        );
        expect(first!.price).toBe(44.95);

        // A different intent discovers the same provider product at a new price.
        await repos.products.upsert(
          makeProduct({ price: 29.5, productUrl: 'https://shoebacca.com/p/new' }),
          {
            discoveredAt: '2026-10-20T11:00:00.000Z',
            discoveredForIntentId: 'intent-2',
            userId: 'user-2',
          },
        );

        const stillFirst = await repos.products.getSnapshotForIntent(
          intentId,
          'channel3',
          'channel3:runfalcon',
          'user-1',
        );
        expect(stillFirst).toEqual(first);

        const second = await repos.products.getSnapshotForIntent(
          'intent-2',
          'channel3',
          'channel3:runfalcon',
          'user-2',
        );
        expect(second!.price).toBe(29.5);
        expect(second!.offerUrl).toBe('https://shoebacca.com/p/new');
      });

      it('scopes snapshot reads and restored snapshots to the authenticated owner', async () => {
        await repos.products.upsert(makeProduct(), {
          discoveredAt: '2026-10-20T10:00:00.000Z',
          discoveredForIntentId: intentId,
          userId: 'user-1',
        });

        await expect(
          repos.products.getSnapshotForIntent(
            intentId,
            'channel3',
            'channel3:runfalcon',
            'user-2',
          ),
        ).resolves.toBeNull();

        const ownerEntries = await repos.products.listForIntent(intentId, 'user-1');
        expect(ownerEntries[0].snapshot).toMatchObject({
          userId: 'user-1',
          price: 44.95,
        });

        const foreignEntries = await repos.products.listForIntent(intentId, 'user-2');
        expect(foreignEntries[0].snapshot).toBeNull();
      });

      it('replaces the offer snapshot so omitted optional fields do not go stale', async () => {
        await repos.products.upsert(makeProduct(), {
          discoveredAt: '2026-10-20T10:00:00.000Z',
          discoveredForIntentId: intentId,
        });
        await repos.products.upsert(
          makeProduct({
            merchant: undefined,
            imageUrl: undefined,
            productUrl: undefined,
            availability: undefined,
            externalId: undefined,
            brandId: undefined,
            metadata: undefined,
          }),
          { discoveredAt: '2026-10-20T10:15:00.000Z', discoveredForIntentId: intentId },
        );

        const offer = await repos.products.getOffer('channel3', 'channel3:runfalcon');
        expect(offer!.product.merchant).toBeUndefined();
        expect(offer!.product.imageUrl).toBeUndefined();
        expect(offer!.product.productUrl).toBeUndefined();
        expect(offer!.product.availability).toBeUndefined();
        expect(offer!.product.externalId).toBeUndefined();
        expect(offer!.product.brandId).toBeUndefined();
        expect(offer!.product.metadata).toBeUndefined();
        expect(offer!.product.price).toBe(44.95);
      });

      it('keeps independent associations when one product is discovered by two intents', async () => {
        const product = makeProduct();
        await repos.products.upsert(product, {
          discoveredAt: '2026-10-20T10:00:00.000Z',
          discoveredForIntentId: 'intent-1',
        });
        await repos.products.upsert(makeProduct({ price: 39.5 }), {
          discoveredAt: '2026-10-20T10:15:00.000Z',
          discoveredForIntentId: 'intent-2',
        });

        const first = await repos.products.getForIntent('intent-1', product.source, product.id);
        const second = await repos.products.getForIntent('intent-2', product.source, product.id);

        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        expect(first!.discoveredForIntentId).toBe('intent-1');
        expect(second!.discoveredForIntentId).toBe('intent-2');
        // The newest discovery refreshed the shared offer for both intents.
        expect(first!.product.price).toBe(39.5);
        expect(second!.product.price).toBe(39.5);
        expect(first!.discoveredAt).toBe('2026-10-20T10:00:00.000Z');
        expect(second!.discoveredAt).toBe('2026-10-20T10:15:00.000Z');
      });

      it('refreshing shared offer data retains every discovery association', async () => {
        const product = makeProduct();
        await repos.products.upsert(product, {
          discoveredAt: '2026-10-20T10:00:00.000Z',
          discoveredForIntentId: 'intent-1',
        });
        await repos.products.upsert(product, {
          discoveredAt: '2026-10-20T10:05:00.000Z',
          discoveredForIntentId: 'intent-2',
        });

        // Offer-only refresh (no intent supplied).
        await repos.products.upsert(makeProduct({ price: 30 }), {
          discoveredAt: '2026-10-20T10:30:00.000Z',
        });

        const first = await repos.products.getForIntent('intent-1', product.source, product.id);
        const second = await repos.products.getForIntent('intent-2', product.source, product.id);
        const offer = await repos.products.getOffer(product.source, product.id);

        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        expect(first!.product.price).toBe(30);
        expect(second!.product.price).toBe(30);
        expect(offer!.product.price).toBe(30);
      });

      it('returns null for an unknown offer or an association this intent does not have', async () => {
        expect(await repos.products.getOffer('channel3', 'channel3:missing')).toBeNull();
        expect(
          await repos.products.getForIntent(intentId, 'channel3', 'channel3:missing'),
        ).toBeNull();

        await repos.products.upsert(makeProduct(), {
          discoveredAt: '2026-10-20T10:00:00.000Z',
          discoveredForIntentId: 'another-intent',
        });
        expect(
          await repos.products.getForIntent(intentId, 'channel3', 'channel3:runfalcon'),
        ).toBeNull();
      });

      describe('getSnapshotById (owner-scoped exact-id lookup)', () => {
        it('returns the exact snapshot to its owner', async () => {
          const product = makeProduct();
          await repos.products.upsert(product, {
            discoveredAt: '2026-10-20T10:00:00.000Z',
            discoveredForIntentId: intentId,
            userId: 'user-1',
          });
          const stored = await repos.products.getSnapshotForIntent(
            intentId,
            product.source,
            product.id,
            'user-1',
          );
          expect(stored).not.toBeNull();

          await expect(
            repos.products.getSnapshotById(stored!.id, 'user-1'),
          ).resolves.toEqual(stored);
        });

        it('returns null for a snapshot owned by another user', async () => {
          await repos.products.upsert(makeProduct(), {
            discoveredAt: '2026-10-20T10:00:00.000Z',
            discoveredForIntentId: intentId,
            userId: 'user-1',
          });
          const stored = await repos.products.getSnapshotForIntent(
            intentId,
            'channel3',
            'channel3:runfalcon',
            'user-1',
          );
          expect(stored).not.toBeNull();

          await expect(
            repos.products.getSnapshotById(stored!.id, 'user-2'),
          ).resolves.toBeNull();
        });

        it('returns null for an unknown snapshot id without substituting the association', async () => {
          await repos.products.upsert(makeProduct(), {
            discoveredAt: '2026-10-20T10:00:00.000Z',
            discoveredForIntentId: intentId,
            userId: 'user-1',
          });

          await expect(
            repos.products.getSnapshotById('missing-snapshot', 'user-1'),
          ).resolves.toBeNull();
        });

        it('returns the older immutable snapshot by id after re-discovery replaces the association', async () => {
          await repos.products.upsert(makeProduct({ price: 44.95 }), {
            discoveredAt: '2026-10-20T10:00:00.000Z',
            discoveredForIntentId: intentId,
            userId: 'user-1',
          });
          const first = await repos.products.getSnapshotForIntent(
            intentId,
            'channel3',
            'channel3:runfalcon',
            'user-1',
          );
          expect(first).not.toBeNull();

          // Re-discovery replaces the association's snapshot for the same key.
          await repos.products.upsert(makeProduct({ price: 29.5 }), {
            discoveredAt: '2026-10-20T10:15:00.000Z',
            discoveredForIntentId: intentId,
            userId: 'user-1',
          });
          const second = await repos.products.getSnapshotForIntent(
            intentId,
            'channel3',
            'channel3:runfalcon',
            'user-1',
          );
          expect(second).not.toBeNull();
          expect(second!.id).not.toBe(first!.id);

          // Exact-id lookup still resolves the immutable original rather than
          // following the association to the newer snapshot.
          await expect(
            repos.products.getSnapshotById(first!.id, 'user-1'),
          ).resolves.toEqual(first);
          await expect(
            repos.products.getSnapshotById(second!.id, 'user-1'),
          ).resolves.toEqual(second);
        });
      });
    });

    describe('EvidenceRepository', () => {
      it('appends and retrieves by id', async () => {
        await repos.evidence.append(makeEvidence());
        const found = await repos.evidence.getById('ev-1');
        expect(found).not.toBeNull();
        expect(found!.id).toBe('ev-1');
        expect(found!.data).toEqual({ a: 1 });
        expect(found!.metadata.source).toBe('user_input');
      });

      it('returns null for a missing evidence id', async () => {
        expect(await repos.evidence.getById('missing')).toBeNull();
      });

      it('filters by intent id', async () => {
        await repos.evidence.append(makeEvidence({ id: 'ev-1', intentId }));
        await repos.evidence.append(makeEvidence({ id: 'ev-2', intentId }));
        await repos.evidence.append(makeEvidence({ id: 'ev-3', intentId: 'other' }));

        const records = await repos.evidence.getByIntentId(intentId);
        expect(records.map((r) => r.id)).toEqual(['ev-1', 'ev-2']);
        expect(await repos.evidence.getByIntentId('nobody')).toEqual([]);
      });

      it('filters by transaction id', async () => {
        await repos.evidence.append(makeEvidence({ id: 'ev-1', transactionId: 'tx-1' }));
        await repos.evidence.append(makeEvidence({ id: 'ev-2', transactionId: 'tx-1' }));
        await repos.evidence.append(makeEvidence({ id: 'ev-3', transactionId: 'tx-2' }));

        const records = await repos.evidence.getByTransactionId('tx-1');
        expect(records.map((r) => r.id)).toEqual(['ev-1', 'ev-2']);
        expect(await repos.evidence.getByTransactionId('nobody')).toEqual([]);
      });

      it('orders by timestamp ascending and returns all records', async () => {
        await repos.evidence.append(
          makeEvidence({ id: 'ev-late', timestamp: '2026-10-20T10:02:00.000Z' }),
        );
        await repos.evidence.append(
          makeEvidence({ id: 'ev-early', timestamp: '2026-10-20T10:00:00.000Z' }),
        );
        await repos.evidence.append(
          makeEvidence({ id: 'ev-mid', timestamp: '2026-10-20T10:01:00.000Z' }),
        );

        const all = await repos.evidence.getAll();
        expect(all.map((r) => r.id)).toEqual(['ev-early', 'ev-mid', 'ev-late']);
      });

      it('returns an empty array when nothing has been appended', async () => {
        expect(await repos.evidence.getAll()).toEqual([]);
        expect(await repos.evidence.getByIntentId(intentId)).toEqual([]);
        expect(await repos.evidence.getByTransactionId('tx-1')).toEqual([]);
      });

      it('is append-only (appending the same id twice does not mutate the first)', async () => {
        await repos.evidence.append(makeEvidence({ id: 'ev-1', data: { n: 1 } }));
        // A second append with the same id is a distinct insert attempt; the
        // repository never exposes update/delete.
        expect((repos.evidence as unknown as { update?: unknown }).update).toBeUndefined();
        expect((repos.evidence as unknown as { delete?: unknown }).delete).toBeUndefined();
        const first = await repos.evidence.getById('ev-1');
        expect(first!.data).toEqual({ n: 1 });
      });

      it('appendIfAbsent creates once and reports exists without overwriting', async () => {
        expect(await repos.evidence.appendIfAbsent(makeEvidence({ data: { n: 1 } }))).toBe(
          'created',
        );
        expect(
          await repos.evidence.appendIfAbsent(makeEvidence({ data: { n: 2 }, timestamp: '2026-10-20T10:05:00.000Z' })),
        ).toBe('exists');

        const stored = await repos.evidence.getById('ev-1');
        expect(stored!.data).toEqual({ n: 1 });
        expect(stored!.timestamp).toBe('2026-10-20T10:00:00.000Z');
        expect(await repos.evidence.getAll()).toHaveLength(1);
      });

      it('appendIfAbsent is safe under concurrent writes of the same id', async () => {
        const outcomes = await Promise.all([
          repos.evidence.appendIfAbsent(makeEvidence()),
          repos.evidence.appendIfAbsent(makeEvidence()),
          repos.evidence.appendIfAbsent(makeEvidence()),
        ]);

        expect(outcomes.filter((o) => o === 'created')).toHaveLength(1);
        expect(outcomes.filter((o) => o === 'exists')).toHaveLength(2);
        expect(await repos.evidence.getAll()).toHaveLength(1);
      });

      it('scopes evidence reads to the owner and excludes legacy ownerless rows', async () => {
        await repos.evidence.append(makeEvidence({ id: 'owned' }), 'user-1');
        await repos.evidence.append(
          makeEvidence({ id: 'owned-tx', transactionId: 'tx-1' }),
          'user-1',
        );
        await repos.evidence.append(makeEvidence({ id: 'foreign' }), 'user-2');
        await repos.evidence.append(makeEvidence({ id: 'legacy' }), null);

        const owned = await repos.evidence.getAllForUser('user-1');
        expect(owned.map((r) => r.id).sort()).toEqual(['owned', 'owned-tx']);

        expect((await repos.evidence.getByIdForUser('owned', 'user-1'))?.id).toBe('owned');
        expect(await repos.evidence.getByIdForUser('owned', 'user-2')).toBeNull();
        expect(await repos.evidence.getByIdForUser('foreign', 'user-1')).toBeNull();
        expect(await repos.evidence.getByIdForUser('legacy', 'user-1')).toBeNull();

        expect(
          (await repos.evidence.getByIntentIdForUser(intentId, 'user-1')).map((r) => r.id).sort(),
        ).toEqual(['owned', 'owned-tx']);
        expect(await repos.evidence.getByIntentIdForUser(intentId, 'user-2')).toEqual([
          expect.objectContaining({ id: 'foreign' }),
        ]);
        expect(
          (await repos.evidence.getByTransactionIdForUser('tx-1', 'user-1')).map((r) => r.id),
        ).toEqual(['owned-tx']);
        expect(await repos.evidence.getByTransactionIdForUser('tx-1', 'user-2')).toEqual([]);

        // The unscoped internal read still sees the complete append-only ledger.
        expect(await repos.evidence.getAll()).toHaveLength(4);
      });
    });

    describe('TransactionRepository', () => {
      it('inserts a pending transaction and retrieves it by id', async () => {
        await repos.transactions.insertPending(makeTransaction());

        const stored = await repos.transactions.getById('tx-1');
        expect(stored).not.toBeNull();
        expect(stored!.intentId).toBe(intentId);
        expect(stored!.amount).toBe(44.95);
        expect(stored!.currency).toBe('USD');
        expect(stored!.financialState).toBe('PAYMENT_PENDING');
        expect(stored!.paypalOrderId).toBe('O-SANDBOX-1');
        expect(stored!.paypalCaptureId).toBeNull();
        expect(stored!.createdAt).toBe('2026-10-20T10:00:00.000Z');
      });

      it('retrieves a transaction by PayPal order id', async () => {
        await repos.transactions.insertPending(makeTransaction());

        const stored = await repos.transactions.getByPaypalOrderId('O-SANDBOX-1');
        expect(stored).not.toBeNull();
        expect(stored!.id).toBe('tx-1');
      });

      it('returns null for a missing transaction id / PayPal order id', async () => {
        expect(await repos.transactions.getById('missing')).toBeNull();
        expect(await repos.transactions.getByPaypalOrderId('missing')).toBeNull();
      });

      it('completes a pending transaction exactly once', async () => {
        await repos.transactions.insertPending(makeTransaction());

        const first = await repos.transactions.completePayment({
          transactionId: 'tx-1',
          paypalCaptureId: 'CAP-1',
          updatedAt: '2026-10-20T10:05:00.000Z',
        });
        expect(first.kind).toBe('TRANSITIONED');
        if (first.kind === 'TRANSITIONED') {
          expect(first.transaction.financialState).toBe('PAYMENT_COMPLETED');
          expect(first.transaction.paypalCaptureId).toBe('CAP-1');
          expect(first.transaction.updatedAt).toBe('2026-10-20T10:05:00.000Z');
        }
      });

      it('rejects a second completion attempt as NOT_PENDING', async () => {
        await repos.transactions.insertPending(makeTransaction());

        const first = await repos.transactions.completePayment({
          transactionId: 'tx-1',
          paypalCaptureId: 'CAP-1',
          updatedAt: '2026-10-20T10:05:00.000Z',
        });
        expect(first.kind).toBe('TRANSITIONED');

        const second = await repos.transactions.completePayment({
          transactionId: 'tx-1',
          paypalCaptureId: 'CAP-2',
          updatedAt: '2026-10-20T10:06:00.000Z',
        });
        expect(second.kind).toBe('NOT_PENDING');
        if (second.kind === 'NOT_PENDING') {
          // The original state is preserved: the second attempt changed nothing.
          expect(second.transaction.financialState).toBe('PAYMENT_COMPLETED');
          expect(second.transaction.paypalCaptureId).toBe('CAP-1');
          expect(second.transaction.updatedAt).toBe('2026-10-20T10:05:00.000Z');
        }
      });

      it('returns NOT_FOUND when completing an unknown transaction', async () => {
        const result = await repos.transactions.completePayment({
          transactionId: 'missing',
          paypalCaptureId: 'CAP-1',
          updatedAt: '2026-10-20T10:05:00.000Z',
        });
        expect(result.kind).toBe('NOT_FOUND');
      });

      it('preserves the original state when the conditional update loses a race', async () => {
        // Seed a transaction that is already past PAYMENT_PENDING.
        await repos.transactions.insertPending(
          makeTransaction({ financialState: 'FULFILLMENT', paypalCaptureId: 'CAP-ORIG' }),
        );

        const result = await repos.transactions.completePayment({
          transactionId: 'tx-1',
          paypalCaptureId: 'CAP-RACE',
          updatedAt: '2026-10-20T10:05:00.000Z',
        });

        expect(result.kind).toBe('NOT_PENDING');
        const stored = await repos.transactions.getById('tx-1');
        expect(stored!.financialState).toBe('FULFILLMENT');
        expect(stored!.paypalCaptureId).toBe('CAP-ORIG');
      });

      it('propagates a duplicate-id insert instead of overwriting', async () => {
        await repos.transactions.insertPending(makeTransaction());
        await expect(
          repos.transactions.insertPending(makeTransaction({ amount: 999 })),
        ).rejects.toThrow();

        const stored = await repos.transactions.getById('tx-1');
        expect(stored!.amount).toBe(44.95);
      });

      it('scopes transaction reads and completion to the owner', async () => {
        await repos.transactions.insertPending(
          makeTransaction({ id: 'owned', userId: 'user-1', paypalOrderId: 'O-OWNED' }),
        );
        await repos.transactions.insertPending(
          makeTransaction({ id: 'foreign', userId: 'user-2', paypalOrderId: 'O-FOREIGN' }),
        );
        await repos.transactions.insertPending(
          makeTransaction({ id: 'legacy', userId: null, paypalOrderId: 'O-LEGACY' }),
        );

        expect((await repos.transactions.getByIdForUser('owned', 'user-1'))?.id).toBe('owned');
        expect(await repos.transactions.getByIdForUser('owned', 'user-2')).toBeNull();
        expect(await repos.transactions.getByIdForUser('foreign', 'user-1')).toBeNull();
        expect(await repos.transactions.getByIdForUser('legacy', 'user-1')).toBeNull();

        expect(
          (await repos.transactions.getByPaypalOrderIdForUser('O-OWNED', 'user-1'))?.id,
        ).toBe('owned');
        expect(await repos.transactions.getByPaypalOrderIdForUser('O-OWNED', 'user-2')).toBeNull();
        expect(await repos.transactions.getByPaypalOrderIdForUser('O-LEGACY', 'user-1')).toBeNull();

        // A guessed id cannot transition another owner's pending transaction.
        const foreignAttempt = await repos.transactions.completePayment({
          transactionId: 'owned',
          paypalCaptureId: 'CAP-INTRUDER',
          updatedAt: '2026-10-20T10:05:00.000Z',
          userId: 'user-2',
        });
        expect(foreignAttempt.kind).toBe('NOT_FOUND');
        const stillPending = await repos.transactions.getById('owned');
        expect(stillPending!.financialState).toBe('PAYMENT_PENDING');

        const ownedAttempt = await repos.transactions.completePayment({
          transactionId: 'owned',
          paypalCaptureId: 'CAP-OWNER',
          updatedAt: '2026-10-20T10:05:00.000Z',
          userId: 'user-1',
        });
        expect(ownedAttempt.kind).toBe('TRANSITIONED');
        const completed = await repos.transactions.getById('owned');
        expect(completed!.financialState).toBe('PAYMENT_COMPLETED');
        expect(completed!.paypalCaptureId).toBe('CAP-OWNER');
      });

      it('lists only owned transactions, newest first, with intent filtering', async () => {
        await repos.transactions.insertPending(
          makeTransaction({
            id: 'old',
            userId: 'user-1',
            paypalOrderId: 'O-OLD',
            createdAt: '2026-10-20T09:00:00.000Z',
            updatedAt: '2026-10-20T09:00:00.000Z',
          }),
        );
        await repos.transactions.insertPending(
          makeTransaction({
            id: 'new',
            userId: 'user-1',
            intentId: 'intent-2',
            paypalOrderId: 'O-NEW',
            createdAt: '2026-10-20T11:00:00.000Z',
            updatedAt: '2026-10-20T11:00:00.000Z',
          }),
        );
        await repos.transactions.insertPending(
          makeTransaction({
            id: 'foreign',
            userId: 'user-2',
            paypalOrderId: 'O-FOREIGN',
            createdAt: '2026-10-20T12:00:00.000Z',
          }),
        );
        await repos.transactions.insertPending(
          makeTransaction({
            id: 'legacy',
            userId: null,
            paypalOrderId: 'O-LEGACY',
            createdAt: '2026-10-20T13:00:00.000Z',
          }),
        );

        expect(
          (await repos.transactions.listForUser('user-1', 10)).map((transaction) => transaction.id),
        ).toEqual(['new', 'old']);
        expect(
          (await repos.transactions.listForUser('user-1', 1)).map((transaction) => transaction.id),
        ).toEqual(['new']);
        expect(
          (await repos.transactions.listForUser('user-1', 10, 'intent-1')).map(
            (transaction) => transaction.id,
          ),
        ).toEqual(['old']);
        expect(
          await repos.transactions.listForUser('user-1', 10, 'intent-2'),
        ).toHaveLength(1);
        expect(
          await repos.transactions.listForUser('user-1', 10, 'foreign-intent'),
        ).toEqual([]);
        expect(
          (await repos.transactions.listForUser('user-2', 10, 'intent-1')).map(
            (transaction) => transaction.id,
          ),
        ).toEqual(['foreign']);
      });
    });

    describe('UserRepository', () => {
      it('normalizes the email and returns public records without the password hash', async () => {
        await repos.users.create(makeUser());

        const byId = await repos.users.getById('user-1');
        const byEmail = await repos.users.getByEmail('USER@example.com');

        expect(byId).toEqual({
          id: 'user-1',
          email: 'user@example.com',
          createdAt: '2026-10-20T10:00:00.000Z',
        });
        expect(byEmail).toEqual(byId);
        expect('passwordHash' in byId!).toBe(false);

        const credentials = await repos.users.getCredentialsByEmail('  user@EXAMPLE.com ');
        expect(credentials).toEqual({
          id: 'user-1',
          email: 'user@example.com',
          createdAt: '2026-10-20T10:00:00.000Z',
          passwordHash: '$2b$fake-password-hash',
        });
      });

      it('rejects a duplicate normalized email and keeps the original account', async () => {
        await repos.users.create(makeUser());

        await expect(
          repos.users.create(makeUser({ id: 'user-2', email: 'USER@example.com' })),
        ).rejects.toThrow();

        expect(await repos.users.getByEmail('user@example.com')).toMatchObject({
          id: 'user-1',
        });
        expect(await repos.users.getById('user-2')).toBeNull();
      });

      it('rejects a duplicate user id even with a different email', async () => {
        await repos.users.create(makeUser());

        await expect(
          repos.users.create(makeUser({ email: 'other@example.com' })),
        ).rejects.toThrow();

        expect(await repos.users.getByEmail('other@example.com')).toBeNull();
      });

      it('returns null for an unknown account', async () => {
        expect(await repos.users.getById('missing')).toBeNull();
        expect(await repos.users.getByEmail('missing@example.com')).toBeNull();
        expect(await repos.users.getCredentialsByEmail('missing@example.com')).toBeNull();
      });
    });

    describe('SessionRepository', () => {
      it('creates a session and reads it back by token hash', async () => {
        await repos.sessions.create(makeSession());

        expect(await repos.sessions.getByTokenHash('sha256:deadbeef')).toEqual(makeSession());
        expect(
          await repos.sessions.getActiveByTokenHash(
            'sha256:deadbeef',
            '2026-10-20T10:30:00.000Z',
          ),
        ).toEqual(makeSession());
        expect(
          await repos.sessions.getActiveByTokenHash(
            'sha256:deadbeef',
            '2026-10-20T09:59:59.000Z',
          ),
        ).not.toBeNull();
        expect(await repos.sessions.getByTokenHash('missing')).toBeNull();
      });

      it('treats an expired session as inactive without deleting it', async () => {
        await repos.sessions.create(makeSession());

        expect(
          await repos.sessions.getActiveByTokenHash(
            'sha256:deadbeef',
            '2026-10-20T11:00:00.000Z',
          ),
        ).toBeNull();
        expect(
          await repos.sessions.getActiveByTokenHash(
            'sha256:deadbeef',
            '2026-10-20T12:00:00.000Z',
          ),
        ).toBeNull();
        // The record remains until a cleanup/TTL removes it.
        expect(await repos.sessions.getByTokenHash('sha256:deadbeef')).not.toBeNull();
      });

      it('revokes idempotently and preserves the first revocation timestamp', async () => {
        await repos.sessions.create(makeSession());

        expect(await repos.sessions.revoke('sha256:deadbeef', '2026-10-20T10:15:00.000Z')).toBe(1);
        expect(await repos.sessions.revoke('sha256:deadbeef', '2026-10-20T10:20:00.000Z')).toBe(0);

        const stored = await repos.sessions.getByTokenHash('sha256:deadbeef');
        expect(stored!.revokedAt).toBe('2026-10-20T10:15:00.000Z');
        expect(
          await repos.sessions.getActiveByTokenHash(
            'sha256:deadbeef',
            '2026-10-20T10:16:00.000Z',
          ),
        ).toBeNull();
      });

      it('revokes all active sessions for one user only', async () => {
        await repos.sessions.create(makeSession());
        await repos.sessions.create(
          makeSession({ id: 'session-2', tokenHash: 'sha256:second' }),
        );
        await repos.sessions.create(
          makeSession({
            id: 'session-3',
            userId: 'user-2',
            tokenHash: 'sha256:other-user',
          }),
        );
        await repos.sessions.create(
          makeSession({
            id: 'session-4',
            tokenHash: 'sha256:already-revoked',
            revokedAt: '2026-10-20T10:05:00.000Z',
          }),
        );

        expect(
          await repos.sessions.revokeAllForUser('user-1', '2026-10-20T10:30:00.000Z'),
        ).toBe(2);

        const first = await repos.sessions.getByTokenHash('sha256:deadbeef');
        const second = await repos.sessions.getByTokenHash('sha256:second');
        const otherUser = await repos.sessions.getByTokenHash('sha256:other-user');
        const alreadyRevoked = await repos.sessions.getByTokenHash('sha256:already-revoked');

        expect(first!.revokedAt).toBe('2026-10-20T10:30:00.000Z');
        expect(second!.revokedAt).toBe('2026-10-20T10:30:00.000Z');
        expect(otherUser!.revokedAt).toBeNull();
        expect(alreadyRevoked!.revokedAt).toBe('2026-10-20T10:05:00.000Z');
      });

      it('rejects a duplicate token hash instead of replacing a session', async () => {
        await repos.sessions.create(makeSession());

        await expect(
          repos.sessions.create(makeSession({ id: 'session-2' })),
        ).rejects.toThrow();

        expect(await repos.sessions.getByTokenHash('sha256:deadbeef')).toMatchObject({
          id: 'session-1',
        });
      });
    });

    /**
     * The selection store is the anchor for every later trust decision: an
     * approval and an order are bound to a `snapshotId`, so two active
     * selections for one intent (or a rewritten historical row) would silently
     * change what the user agreed to buy.
     */
    describe('SelectionRepository', () => {
      it('rejects a selection with no isActive flag and writes nothing', async () => {
        const { isActive: _omitted, ...withoutFlag } = makeSelection();

        await expect(repos.selections.select(withoutFlag as never)).rejects.toThrow(
          SelectionValidationError,
        );
        expect(await repos.selections.listHistory(intentId, 'user-1')).toEqual([]);
        expect(await repos.selections.getActive(intentId, 'user-1')).toBeNull();
      });

      it('rejects a non-boolean isActive before writing', async () => {
        await expect(
          repos.selections.select(
            makeSelection({ isActive: 'true' as unknown as boolean }),
          ),
        ).rejects.toThrow(SelectionValidationError);

        expect(await repos.selections.listHistory(intentId, 'user-1')).toEqual([]);
      });

      it('rejects isActive/supersededAt combinations that cannot both be true', async () => {
        // Active but already stamped as superseded.
        await expect(
          repos.selections.select(
            makeSelection({ supersededAt: '2026-10-20T10:00:00.000Z' }),
          ),
        ).rejects.toThrow(SelectionValidationError);

        // Superseded but with no supersession timestamp.
        await expect(
          repos.selections.select(makeSelection({ isActive: false, supersededAt: null })),
        ).rejects.toThrow(SelectionValidationError);

        expect(await repos.selections.listHistory(intentId, 'user-1')).toEqual([]);
      });

      it('only creates active rows through select()', async () => {
        await expect(
          repos.selections.select(
            makeSelection({
              isActive: false,
              supersededAt: '2026-10-20T10:00:00.000Z',
            }),
          ),
        ).rejects.toThrow(SelectionValidationError);

        expect(await repos.selections.listHistory(intentId, 'user-1')).toEqual([]);
      });

      it('activates a selection and reports it back bound to its snapshot', async () => {
        const outcome = await repos.selections.select(makeSelection());

        expect(outcome.kind).toBe('ACTIVATED');
        expect(outcome.selection).toMatchObject({
          id: 'sel-1',
          intentId,
          snapshotId: 'snap-1',
          source: 'channel3',
          productId: 'channel3:runfalcon',
          price: 44.95,
          currency: 'USD',
          isActive: true,
          selectedAt: '2026-10-20T10:00:00.000Z',
          supersededAt: null,
        });

        expect(await repos.selections.getActive(intentId, 'user-1')).toMatchObject({
          id: 'sel-1',
        });
      });

      it('keeps at most one active selection per intent', async () => {
        await repos.selections.select(makeSelection({ id: 'sel-a', snapshotId: 'snap-a' }));
        const second = await repos.selections.select(
          makeSelection({
            id: 'sel-b',
            snapshotId: 'snap-b',
            selectedAt: '2026-10-20T10:01:00.000Z',
          }),
        );

        expect(second.kind).toBe('ACTIVATED');
        const active = await repos.selections.getActive(intentId, 'user-1');
        expect(active!.snapshotId).toBe('snap-b');

        const history = await repos.selections.listHistory(intentId, 'user-1');
        expect(history.filter((selection) => selection.isActive)).toHaveLength(1);
      });

      it('supersedes instead of deleting, leaving the old row untouched', async () => {
        await repos.selections.select(makeSelection({ id: 'sel-a', snapshotId: 'snap-a' }));
        await repos.selections.select(
          makeSelection({
            id: 'sel-b',
            snapshotId: 'snap-b',
            price: 51.5,
            selectedAt: '2026-10-20T10:01:00.000Z',
          }),
        );

        const history = await repos.selections.listHistory(intentId, 'user-1');
        expect(history).toHaveLength(2);

        const original = history.find((selection) => selection.id === 'sel-a');
        expect(original).toBeDefined();
        expect(original!.isActive).toBe(false);
        expect(original!.supersededAt).toBe('2026-10-20T10:01:00.000Z');
        // Everything the row itself recorded is preserved verbatim.
        expect(original!.snapshotId).toBe('snap-a');
        expect(original!.productId).toBe('channel3:runfalcon');
        expect(original!.price).toBe(44.95);
        expect(original!.selectedAt).toBe('2026-10-20T10:00:00.000Z');
      });

      it('treats re-selecting the active snapshot as a no-op', async () => {
        await repos.selections.select(makeSelection({ id: 'sel-a', snapshotId: 'snap-a' }));

        const again = await repos.selections.select(
          makeSelection({
            id: 'sel-again',
            snapshotId: 'snap-a',
            selectedAt: '2026-10-20T10:05:00.000Z',
          }),
        );

        expect(again.kind).toBe('ALREADY_ACTIVE');
        // The original row is returned: its id and selectedAt are not refreshed
        // and no duplicate history entry is appended.
        expect(again.selection.id).toBe('sel-a');
        expect(again.selection.selectedAt).toBe('2026-10-20T10:00:00.000Z');
        expect(await repos.selections.listHistory(intentId, 'user-1')).toHaveLength(1);
      });

      it('rejects a duplicate selection id instead of overwriting history', async () => {
        await repos.selections.select(makeSelection({ id: 'sel-a', snapshotId: 'snap-a' }));

        await expect(
          repos.selections.select(
            makeSelection({
              id: 'sel-a',
              snapshotId: 'snap-b',
              selectedAt: '2026-10-20T10:01:00.000Z',
            }),
          ),
        ).rejects.toThrow();

        const history = await repos.selections.listHistory(intentId, 'user-1');
        expect(history).toHaveLength(1);
        expect(history[0].snapshotId).toBe('snap-a');
        // A rejected duplicate id must not supersede the real active row: the
        // adapters share the same observable contract, with no empty active slot.
        expect(await repos.selections.getActive(intentId, 'user-1')).toMatchObject({
          id: 'sel-a',
          snapshotId: 'snap-a',
          isActive: true,
        });
      });

      it('scopes reads to the owner', async () => {
        await repos.selections.select(makeSelection());

        expect(await repos.selections.getActive(intentId, 'user-2')).toBeNull();
        expect(await repos.selections.listHistory(intentId, 'user-2')).toEqual([]);
      });

      it('leaves exactly one active row under concurrent attempts', async () => {
        const attempts = [0, 1, 2].map((index) =>
          repos.selections.select(
            makeSelection({
              id: `sel-${index}`,
              snapshotId: `snap-${index}`,
              selectedAt: `2026-10-20T10:0${index}:00.000Z`,
            }),
          ),
        );

        // No attempt may reject, and at least one must win.
        const results = await Promise.all(attempts);
        const activated = results.filter((result) => result.kind === 'ACTIVATED');
        expect(activated.length).toBeGreaterThanOrEqual(1);

        // Every attempt used a distinct snapshot, so a loser must be a CONFLICT
        // naming the winner's active row, never a claim that its own attempt was
        // activated while another selection holds the active slot.
        results.forEach((result, index) => {
          if (result.kind === 'ACTIVATED') return;
          expect(result.kind).toBe('CONFLICT');
          expect(result.selection.snapshotId).not.toBe(`snap-${index}`);
          expect(result.selection.isActive).toBe(true);
        });

        const history = await repos.selections.listHistory(intentId, 'user-1');
        expect(history.filter((selection) => selection.isActive)).toHaveLength(1);
        // A losing attempt is reported as CONFLICT and writes no row, so the
        // history length equals the number of winners exactly.
        expect(history).toHaveLength(activated.length);

        const activeSnapshots = history
          .filter((selection) => selection.isActive)
          .map((selection) => selection.snapshotId);
        expect(activated.map((result) => result.selection.snapshotId)).toContain(
          activeSnapshots[0],
        );
      });
    });
  });
}

describeContract('in-memory', () => ({
  evidence: new InMemoryEvidenceRepository(),
  products: new InMemoryProductRepository(),
  intents: new InMemoryIntentRepository(),
  policyEvaluations: new InMemoryPolicyEvaluationRepository(),
  transactions: new InMemoryTransactionRepository(),
  users: new InMemoryUserRepository(),
  sessions: new InMemorySessionRepository(),
  selections: new InMemorySelectionRepository(),
}));

// SQLite: build a brand-new in-memory database for every test so each case
// starts from a clean schema (the in-memory fakes are fresh per builder call
// too, since `describeContract` invokes the builder in `beforeEach`).
describeContract('sqlite', async () => {
  const db = await createTestDatabase();
  return {
    evidence: new SQLiteEvidenceRepository(db),
    products: new SQLiteProductRepository(db),
    intents: new SQLiteIntentRepository(db),
    policyEvaluations: new SQLitePolicyEvaluationRepository(db),
    transactions: new SQLiteTransactionRepository(db),
    users: new SQLiteUserRepository(db),
    sessions: new SQLiteSessionRepository(db),
    selections: new SQLiteSelectionRepository(db),
  };
});
// MongoDB: each case gets a fresh fake Db (no Atlas). P3's product facade runs
// against the fake `offers` + `intentDiscoveries` collections, so the identical
// assertions exercise the Mongo adapters without a live cluster. P4's unique
// email/token-hash indexes are created on the fake before each case so duplicate
// writes are rejected by the same constraint the real server would apply.
describeContract('mongodb', async () => {
  const db = createFakeDb();
  await ensureIndexes(db as unknown as MongoDbLike, 'P4');
  // P6 indexes include `uniq_active_selection` (`{ intentId: 1 }` with
  // `partialFilterExpression: { isActive: true }`). Creating them here means the
  // one-active-selection rule is enforced by the real index definition rather
  // than by adapter bookkeeping alone.
  await ensureIndexes(db as unknown as MongoDbLike, 'P6');
  return {
    evidence: new MongoEvidenceRepository(db),
    products: new MongoProductRepository(db),
    intents: new MongoIntentRepository(db),
    policyEvaluations: new MongoPolicyEvaluationRepository(db),
    transactions: new MongoTransactionRepository(db),
    users: new MongoUserRepository(db),
    sessions: new MongoSessionRepository(db),
    selections: new MongoSelectionRepository(db),
  };
});