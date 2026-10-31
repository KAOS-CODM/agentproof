import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Product, StructuredIntent } from '@agentproof/shared';
import { intentRouter } from './intent.js';
import { policyRouter } from './policy.js';
import { productsRouter } from './products.js';
import { selectionsRouter } from './selections.js';
import { evidenceRouter } from './evidence.js';
import { paymentsRouter } from './payments.js';
import { authRouter } from './auth.js';
import { setRepositoryOverrides } from '../models/repositories.js';
import { config } from '../config/env.js';
import { hashPassword } from '../services/auth/passwordHasher.js';
import {
  InMemoryEvidenceRepository,
  InMemoryIntentRepository,
  InMemoryPolicyEvaluationRepository,
  InMemoryProductRepository,
  InMemorySessionRepository,
  InMemoryTransactionRepository,
  InMemoryUserRepository,
  InMemorySelectionRepository,
} from '../test/inMemoryRepositories.js';

/**
 * HTTP-level regression coverage for the P1a routes, extended in P5 with
 * authentication and per-user ownership.
 *
 * The routers are mounted on a real (ephemeral) Express server and driven over
 * HTTP, but every repository/provider is injected as an in-memory stub so no
 * database is touched and no live provider is called.
 */

const structuredIntent: StructuredIntent = {
  purpose: 'running shoes',
  maxAmount: 150,
  currency: 'USD',
  brands: ['Nike'],
  condition: 'new',
  requiresConfirmationAbove: null,
  constraints: [],
};

function demoProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'demo-nike-pegasus-100',
    source: 'demo_catalog',
    name: 'Nike Air Zoom Pegasus 100',
    description: 'Daily trainer.',
    price: 99,
    currency: 'USD',
    brand: 'Nike',
    condition: 'new',
    category: 'Running Shoes',
    ...overrides,
  };
}

function channel3Product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'channel3:runfalcon',
    source: 'channel3',
    name: 'Runfalcon 3.0',
    description: 'Lightweight running shoes.',
    price: 44.95,
    currency: 'USD',
    brand: 'adidas',
    condition: 'new',
    category: 'Running Shoes',
    merchant: 'shoebacca.com',
    productUrl: 'https://shoebacca.com/p/runfalcon-3?aff=abc',
    availability: 'InStock',
    externalId: '1FesGXD',
    metadata: {
      provider: 'channel3',
      offerDomain: 'shoebacca.com',
      compareAtPrice: 65,
      maxCommissionRate: 0.05,
    },
    ...overrides,
  };
}

async function seedHandoffSnapshot(
  intentId: string,
  ownerId: string,
  product: Product = channel3Product(),
): Promise<string> {
  await productRepo.upsert(product, {
    discoveredAt: new Date().toISOString(),
    discoveredForIntentId: intentId,
    evaluationId: 'pe-handoff',
    decision: 'ALLOW',
    confirmationRequired: false,
    userId: ownerId,
  });
  const snapshot = await productRepo.getSnapshotForIntent(
    intentId,
    product.source,
    product.id,
    ownerId,
  );
  if (!snapshot) throw new Error('Expected seedHandoffSnapshot to create a snapshot');
  return snapshot.id;
}

/**
 * Persist an owner-scoped immutable snapshot for `product`, then activate it
 * through the real selection route. This is the production precondition for
 * /policy/evaluate: the route resolves the bound snapshot instead of trusting
 * client-supplied offer facts.
 */
async function seedActiveSelection(
  intentId: string,
  product: Product = demoProduct(),
  ownerId: string = TEST_USER.id,
): Promise<{ id: string; snapshotId: string }> {
  await productRepo.upsert(product, {
    discoveredAt: new Date().toISOString(),
    discoveredForIntentId: intentId,
    evaluationId: 'pe-selection',
    decision: 'ALLOW',
    confirmationRequired: false,
    userId: ownerId,
  });
  const snapshot = await productRepo.getSnapshotForIntent(
    intentId,
    product.source,
    product.id,
    ownerId,
  );
  if (!snapshot) throw new Error('Expected seedActiveSelection to create a snapshot');

  const res = await post('/api/v1/selections', {
    intentId,
    source: product.source,
    productId: product.id,
    snapshotId: snapshot.id,
  });
  expect(res.status).toBe(201);
  const body = await json<{ selection: { id: string; snapshotId: string } }>(res);
  return body.selection;
}

const TEST_USER = {
  id: 'user-test',
  email: 'test@example.com',
  password: 'correct horse battery staple',
};
const OTHER_USER = {
  id: 'user-other',
  email: 'other@example.com',
  password: 'another correct horse battery staple',
};

let server: Server;
let baseUrl: string;
let cookie: string;
let otherCookie: string;

// One shared set of in-memory stores for the whole suite; individual tests
// reset them as needed.
const intentRepo = new InMemoryIntentRepository();
const policyRepo = new InMemoryPolicyEvaluationRepository();
const evidenceRepo = new InMemoryEvidenceRepository();
const productRepo = new InMemoryProductRepository();
const transactionRepo = new InMemoryTransactionRepository();
const userRepo = new InMemoryUserRepository();
const sessionRepo = new InMemorySessionRepository();
const selectionRepo = new InMemorySelectionRepository();

const discoverySource = {
  async search(_intent: StructuredIntent): Promise<Product[]> {
    return [demoProduct()];
  },
};

const aiStub = {
  async recommendProduct(_intent: StructuredIntent, allowed: Array<{ id: string }>) {
    return { productId: allowed[0].id, model: 'stub-model', rawResponse: '{}' };
  },
};

beforeAll(async () => {
  const now = new Date().toISOString();
  await userRepo.create({
    id: TEST_USER.id,
    email: TEST_USER.email,
    passwordHash: await hashPassword(TEST_USER.password),
    createdAt: now,
  });
  await userRepo.create({
    id: OTHER_USER.id,
    email: OTHER_USER.email,
    passwordHash: await hashPassword(OTHER_USER.password),
    createdAt: now,
  });

  setRepositoryOverrides({
    intent: intentRepo,
    policyEvaluation: policyRepo,
    evidence: evidenceRepo,
    product: productRepo,
    transaction: transactionRepo,
    user: userRepo,
    session: sessionRepo,
    selection: selectionRepo,
    discoverySource,
    ai: aiStub,
  });

  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/intent', intentRouter);
  app.use('/api/v1/policy', policyRouter);
  app.use('/api/v1/products', productsRouter);
  app.use('/api/v1/selections', selectionsRouter);
  app.use('/api/v1/evidence', evidenceRouter);
  app.use('/api/v1/payments', paymentsRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;

  cookie = await login(TEST_USER.email, TEST_USER.password);
  otherCookie = await login(OTHER_USER.email, OTHER_USER.password);
});

afterAll(async () => {
  setRepositoryOverrides({});
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  intentRepo.clear();
  evidenceRepo.records.length = 0;
  policyRepo.evaluations.length = 0;
  productRepo.clear();
  transactionRepo.clear();
  selectionRepo.clear();
});

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get('set-cookie');
  expect(setCookie).toBeTruthy();
  // res.cookie() takes maxAge in milliseconds and serializes Max-Age in
  // seconds. Guard the unit boundary so a session cookie cannot silently
  // expire 1000x earlier than the configured TTL.
  expect(setCookie).toContain(`Max-Age=${Math.floor(config.authSessionTtlMs / 1000)}`);
  return setCookie!.split(';')[0];
}

async function post(path: string, body: unknown, cookieValue: string | null = cookie) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookieValue) headers.cookie = cookieValue;
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function get(path: string, cookieValue: string | null = cookie) {
  const headers: Record<string, string> = {};
  if (cookieValue) headers.cookie = cookieValue;
  return fetch(`${baseUrl}${path}`, { headers });
}

/** Read a JSON body with an explicit expected shape. */
async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function seedIntent(
  id: string,
  ownerId: string | null = TEST_USER.id,
  structured: StructuredIntent = structuredIntent,
  createdAt = '2026-10-20T10:00:00.000Z',
): Promise<void> {
  await intentRepo.create({
    id,
    userId: ownerId,
    rawInput: structured.purpose,
    structured,
    status: 'VALIDATED',
    createdAt,
    parsedAt: createdAt,
    validatedAt: createdAt,
  });
}

describe('HTTP regression: authentication', () => {
  it('rejects protected requests without a session', async () => {
    for (const path of [
      '/api/v1/evidence',
      '/api/v1/intent',
      '/api/v1/intent/anything',
      '/api/v1/payments/history',
      '/api/v1/products/discoveries/anything',
    ]) {
      const res = await get(path, null);
      expect(res.status).toBe(401);
      expect((await json<{ error: string }>(res)).error).toBe('Authentication required');
    }
    const res = await post('/api/v1/intent', { rawInput: 'x' }, null);
    expect(res.status).toBe(401);
  });

  it('rejects invalid credentials with a generic 401', async () => {
    const badPassword = await post(
      '/api/v1/auth/login',
      { email: TEST_USER.email, password: 'wrong' },
      null,
    );
    const unknownUser = await post(
      '/api/v1/auth/login',
      { email: 'nobody@example.com', password: 'wrong' },
      null,
    );
    expect(badPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(await json<{ error: string }>(badPassword)).toEqual({
      error: 'Invalid email or password',
    });
    expect(await json<{ error: string }>(unknownUser)).toEqual({
      error: 'Invalid email or password',
    });
  });

  it('returns the authenticated session', async () => {
    const res = await get('/api/v1/auth/session');
    expect(res.status).toBe(200);
    const body = await json<{ user: { id: string; email: string } }>(res);
    expect(body.user).toEqual({ id: TEST_USER.id, email: TEST_USER.email });
  });
});

describe('HTTP regression: /intent', () => {
  it('creates an intent (201) with a client-supplied structured intent (no AI call)', async () => {
    const res = await post('/api/v1/intent', {
      rawInput: 'running shoes under $150',
      structured: structuredIntent,
    });
    expect(res.status).toBe(201);

    const body = await json<{
      id: string;
      rawInput: string;
      structured: StructuredIntent;
      status: string;
    }>(res);
    expect(body.id).toBeTruthy();
    expect(body.rawInput).toBe('running shoes under $150');
    expect(body.structured).toEqual(structuredIntent);
    expect(body.status).toBe('VALIDATED');

    // The authenticated identity owns the new intent.
    expect(intentRepo.userIdFor(body.id)).toBe(TEST_USER.id);

    // Registered evidence for the creation lifecycle, all owned by the caller.
    const events = evidenceRepo.records.map((r) => r.eventType);
    expect(events).toContain('INTENT_CREATED');
    expect(events).toContain('INTENT_VALIDATED');
  });

  it('ignores a client-supplied userId and never assigns another identity', async () => {
    const res = await post('/api/v1/intent', {
      rawInput: 'running shoes under $150',
      structured: structuredIntent,
      userId: OTHER_USER.id,
    });
    expect(res.status).toBe(201);
    const body = await json<{ id: string }>(res);
    expect(intentRepo.userIdFor(body.id)).toBe(TEST_USER.id);

    const asOther = await get(`/api/v1/intent/${body.id}`, otherCookie);
    expect(asOther.status).toBe(404);
  });

  it('rejects an invalid body with 400', async () => {
    const res = await post('/api/v1/intent', {});
    expect(res.status).toBe(400);
    const body = await json<{ error: string }>(res);
    expect(body.error).toBe('Invalid request');
  });

  it('retrieves an existing intent and 404s for an unknown id', async () => {
    const created = await json<{ id: string }>(await post('/api/v1/intent', {
      rawInput: 'watch',
      structured: { ...structuredIntent, purpose: 'watch' },
    }));

    const found = await get(`/api/v1/intent/${created.id}`);
    expect(found.status).toBe(200);
    const foundBody = await json<{ id: string; structured: StructuredIntent }>(found);
    expect(foundBody.id).toBe(created.id);
    expect(foundBody.structured.purpose).toBe('watch');

    const missing = await get('/api/v1/intent/does-not-exist');
    expect(missing.status).toBe(404);
    expect((await json<{ error: string }>(missing)).error).toBe('Intent not found');
  });

  it('does not reveal another user intent', async () => {
    await seedIntent('intent-other', OTHER_USER.id);

    const res = await get('/api/v1/intent/intent-other');
    expect(res.status).toBe(404);
    expect((await json<{ error: string }>(res)).error).toBe('Intent not found');

    const owner = await get('/api/v1/intent/intent-other', otherCookie);
    expect(owner.status).toBe(200);
  });

  it('lists only the caller saved intents, newest first, with a bounded limit', async () => {
    await seedIntent('intent-older', TEST_USER.id, structuredIntent, '2026-10-20T09:00:00.000Z');
    await seedIntent('intent-newer', TEST_USER.id, structuredIntent, '2026-10-20T11:00:00.000Z');
    await seedIntent('intent-other', OTHER_USER.id, structuredIntent, '2026-10-20T12:00:00.000Z');
    await seedIntent('intent-legacy', null, structuredIntent, '2026-10-20T13:00:00.000Z');

    const all = await get('/api/v1/intent?limit=10');
    expect(all.status).toBe(200);
    const allBody = await json<Array<{ id: string; structured: StructuredIntent }>>(all);
    expect(allBody.map((intent) => intent.id)).toEqual(['intent-newer', 'intent-older']);
    expect(allBody[0].structured).toEqual(structuredIntent);

    const limited = await get('/api/v1/intent?limit=1');
    expect((await json<Array<{ id: string }>>(limited)).map((intent) => intent.id)).toEqual([
      'intent-newer',
    ]);

    const foreign = await get('/api/v1/intent?limit=10', otherCookie);
    expect((await json<Array<{ id: string }>>(foreign)).map((intent) => intent.id)).toEqual([
      'intent-other',
    ]);
  });
});

describe('HTTP regression: /policy/evaluate', () => {
  // Accepted P3 limitation (not a defect and not fixed): an OfferSnapshot does
  // not capture `category`, so the PURPOSE rule matches only the immutable
  // snapshot product name. Discovery can therefore ALLOW a product whose purpose
  // match relied on its category while /evaluate conservatively DENIES it for
  // the same purpose (for example "running shoes"). The ALLOW cases below use a
  // purpose word ("pegasus") that is genuinely present in the snapshot name.
  const allowIntent: StructuredIntent = { ...structuredIntent, purpose: 'pegasus' };
  const cappedIntent: StructuredIntent = { ...allowIntent, maxAmount: 50 };

  // The request schema still requires `structuredIntent` and `product`. These
  // decoys would produce DENY if the route ever trusted them (price 179 exceeds
  // maxAmount 50). The stored intent plus the bound snapshot must win instead.
  const decoyBody = {
    structuredIntent: { ...structuredIntent, purpose: 'running shoes', maxAmount: 50 },
    product: demoProduct({ name: 'Client Supplied Product', price: 179 }),
  };

  it('evaluates the active selection snapshot, persists the evaluation, and records evidence', async () => {
    await seedIntent('intent-1', TEST_USER.id, allowIntent);
    const selection = await seedActiveSelection('intent-1', demoProduct());

    const res = await post('/api/v1/policy/evaluate', {
      intentId: 'intent-1',
      productId: 'demo-nike-pegasus-100',
      ...decoyBody,
    });
    expect(res.status).toBe(200);

    const evaluation = await json<{ result: string; intentId: string; id: string }>(res);
    expect(evaluation.result).toBe('ALLOW');
    expect(evaluation.intentId).toBe('intent-1');
    expect(policyRepo.evaluations).toHaveLength(1);
    expect(policyRepo.evaluations[0].id).toBe(evaluation.id);
    expect(policyRepo.userIdFor(evaluation.id)).toBe(TEST_USER.id);

    const events = evidenceRepo.records.filter((r) => r.eventType === 'POLICY_EVALUATED');
    expect(events).toHaveLength(1);
    expect(events[0].policyEvaluationId).toBe(evaluation.id);
    // Evidence is bound to the exact selection/snapshot that was evaluated.
    expect(events[0].data).toMatchObject({
      selectionId: selection.id,
      snapshotId: selection.snapshotId,
      productId: 'demo-nike-pegasus-100',
    });
  });

  it('denies a selected snapshot above the intent cap and still records the evaluation', async () => {
    await seedIntent('intent-1', TEST_USER.id, cappedIntent);
    // Discovery only persists ALLOW candidates, so an over-cap offer is seeded
    // directly; the selection still goes through the real selection route.
    await seedActiveSelection('intent-1', demoProduct({ price: 179 }));

    const res = await post('/api/v1/policy/evaluate', {
      intentId: 'intent-1',
      productId: 'demo-nike-pegasus-100',
      ...decoyBody,
    });
    expect(res.status).toBe(200);

    const evaluation = await json<{
      result: string;
      ruleResults: Array<{ rule: string; passed: boolean; reason: string | null }>;
    }>(res);
    expect(evaluation.result).toBe('DENY');
    expect(evaluation.ruleResults.find((rule) => rule.rule === 'PRICE')).toMatchObject({
      passed: false,
      reason: 'PRICE_EXCEEDS_INTENT_LIMIT',
    });
    expect(policyRepo.evaluations).toHaveLength(1);
    expect(
      evidenceRepo.records.filter((r) => r.eventType === 'POLICY_EVALUATED'),
    ).toHaveLength(1);
  });

  it('404s for an intent owned by another user and never persists an evaluation', async () => {
    await seedIntent('intent-other', OTHER_USER.id);

    const res = await post('/api/v1/policy/evaluate', {
      intentId: 'intent-other',
      productId: 'demo-nike-pegasus-100',
      structuredIntent,
      product: demoProduct(),
    });
    expect(res.status).toBe(404);
    expect(policyRepo.evaluations).toHaveLength(0);
    expect(evidenceRepo.records).toHaveLength(0);
  });

  it('ignores a client-supplied userId when persisting ownership', async () => {
    await seedIntent('intent-1', TEST_USER.id, allowIntent);
    await seedActiveSelection('intent-1', demoProduct());

    const res = await post('/api/v1/policy/evaluate', {
      intentId: 'intent-1',
      productId: 'demo-nike-pegasus-100',
      ...decoyBody,
      userId: OTHER_USER.id,
    });
    expect(res.status).toBe(200);
    const evaluation = await json<{ id: string }>(res);
    expect(policyRepo.userIdFor(evaluation.id)).toBe(TEST_USER.id);
  });

  it('returns 500 POLICY_EVALUATION_PERSISTENCE_FAILED and writes no evidence when saving fails', async () => {
    await seedIntent('intent-1', TEST_USER.id, allowIntent);
    await seedActiveSelection('intent-1', demoProduct());
    const saveSpy = vi
      .spyOn(policyRepo, 'save')
      .mockRejectedValue(new Error('evaluation store unavailable'));

    try {
      const res = await post('/api/v1/policy/evaluate', {
        intentId: 'intent-1',
        productId: 'demo-nike-pegasus-100',
        ...decoyBody,
      });

      expect(res.status).toBe(500);
      expect(await json<{ error: string }>(res)).toEqual({
        error: 'POLICY_EVALUATION_PERSISTENCE_FAILED',
      });
      expect(saveSpy).toHaveBeenCalledTimes(1);
      // Nothing durable was written and no policy evidence was recorded for a
      // failed save. The seeded selection's PRODUCT_SELECTED event is unrelated.
      expect(policyRepo.evaluations).toHaveLength(0);
      expect(
        evidenceRepo.records.filter((r) => r.eventType === 'POLICY_EVALUATED'),
      ).toHaveLength(0);
    } finally {
      saveSpy.mockRestore();
    }
  });

  it('reports EVALUATION_PERSISTED_EVIDENCE_FAILED without rolling back the saved evaluation', async () => {
    await seedIntent('intent-1', TEST_USER.id, allowIntent);
    await seedActiveSelection('intent-1', demoProduct());
    const appendSpy = vi
      .spyOn(evidenceRepo, 'append')
      .mockRejectedValue(new Error('evidence store unavailable'));

    try {
      const res = await post('/api/v1/policy/evaluate', {
        intentId: 'intent-1',
        productId: 'demo-nike-pegasus-100',
        ...decoyBody,
      });

      expect(res.status).toBe(500);
      const body = await json<{
        error: string;
        evaluationId: string;
        evaluation: { id: string; intentId: string; result: string };
      }>(res);
      expect(body.error).toBe('EVALUATION_PERSISTED_EVIDENCE_FAILED');
      expect(body.evaluationId).toBe(body.evaluation.id);
      expect(body.evaluation).toMatchObject({ intentId: 'intent-1', result: 'ALLOW' });
      expect(appendSpy).toHaveBeenCalledTimes(1);

      // The evaluation remains persisted and owned by the caller; nothing was
      // rolled back. Only the audit event is missing.
      expect(policyRepo.evaluations.map((evaluation) => evaluation.id)).toContain(
        body.evaluationId,
      );
      expect(policyRepo.userIdFor(body.evaluationId)).toBe(TEST_USER.id);
      expect(
        evidenceRepo.records.filter((r) => r.eventType === 'POLICY_EVALUATED'),
      ).toHaveLength(0);
    } finally {
      appendSpy.mockRestore();
    }
  });

  it('rejects an invalid body with 400', async () => {
    const res = await post('/api/v1/policy/evaluate', { intentId: 'x' });
    expect(res.status).toBe(400);
  });

  it('rejects evaluation with 409 NO_ACTIVE_SELECTION when no selection is active', async () => {
    await seedIntent('intent-1', TEST_USER.id, allowIntent);

    const res = await post('/api/v1/policy/evaluate', {
      intentId: 'intent-1',
      productId: 'demo-nike-pegasus-100',
      ...decoyBody,
    });

    expect(res.status).toBe(409);
    expect(await json<{ error: string }>(res)).toEqual({ error: 'NO_ACTIVE_SELECTION' });
    expect(policyRepo.evaluations).toHaveLength(0);
    expect(evidenceRepo.records).toHaveLength(0);
  });

  it('rejects a selection bound to a missing snapshot with 404 SNAPSHOT_NOT_FOUND', async () => {
    await seedIntent('intent-1', TEST_USER.id, allowIntent);
    // There is no API that deletes a snapshot, so a selection pointing at one
    // represents corrupted/legacy state. Seed the row directly; the policy route
    // must still fail closed and must not fall back to the discovery association.
    await selectionRepo.select({
      id: 'sel-missing-snapshot',
      userId: TEST_USER.id,
      intentId: 'intent-1',
      snapshotId: 'snapshot-does-not-exist',
      source: 'demo_catalog',
      productId: 'demo-nike-pegasus-100',
      price: 99,
      currency: 'USD',
      isActive: true,
      selectedAt: new Date().toISOString(),
      supersededAt: null,
    });

    const res = await post('/api/v1/policy/evaluate', {
      intentId: 'intent-1',
      productId: 'demo-nike-pegasus-100',
      ...decoyBody,
    });

    expect(res.status).toBe(404);
    expect(await json<{ error: string }>(res)).toEqual({ error: 'SNAPSHOT_NOT_FOUND' });
    expect(policyRepo.evaluations).toHaveLength(0);
    expect(evidenceRepo.records).toHaveLength(0);
  });

  it('treats another user snapshot as not found and does not leak it', async () => {
    await seedIntent('intent-1', TEST_USER.id, allowIntent);
    const foreignProduct = demoProduct();
    await productRepo.upsert(foreignProduct, {
      discoveredAt: new Date().toISOString(),
      discoveredForIntentId: 'intent-1',
      evaluationId: 'pe-foreign-snapshot',
      decision: 'ALLOW',
      confirmationRequired: false,
      userId: OTHER_USER.id,
    });
    const foreignSnapshot = await productRepo.getSnapshotForIntent(
      'intent-1',
      foreignProduct.source,
      foreignProduct.id,
      OTHER_USER.id,
    );
    expect(foreignSnapshot).not.toBeNull();

    // The selection route would refuse to bind a snapshot the caller cannot see;
    // this row represents a pre-existing/legacy binding that must fail closed.
    await selectionRepo.select({
      id: 'sel-foreign-snapshot',
      userId: TEST_USER.id,
      intentId: 'intent-1',
      snapshotId: foreignSnapshot!.id,
      source: foreignSnapshot!.source,
      productId: foreignSnapshot!.productId,
      price: foreignSnapshot!.price,
      currency: foreignSnapshot!.currency,
      isActive: true,
      selectedAt: new Date().toISOString(),
      supersededAt: null,
    });

    const res = await post('/api/v1/policy/evaluate', {
      intentId: 'intent-1',
      productId: 'demo-nike-pegasus-100',
      ...decoyBody,
    });

    // An owner-scoped miss is indistinguishable from a missing snapshot. The
    // exact body also proves no foreign snapshot content is echoed.
    expect(res.status).toBe(404);
    expect(await json<Record<string, unknown>>(res)).toEqual({ error: 'SNAPSHOT_NOT_FOUND' });
    expect(policyRepo.evaluations).toHaveLength(0);
    expect(evidenceRepo.records).toHaveLength(0);
  });

  it('rejects a stale selected snapshot with 410 STALE_SNAPSHOT', async () => {
    await seedIntent('intent-1', TEST_USER.id, allowIntent);
    // New selection writes refuse stale snapshots, but a legacy/expired active
    // row can still exist. Policy evaluation must remain the final freshness
    // gate (window: one hour, with a five-minute future tolerance).
    const staleProduct = demoProduct();
    await productRepo.upsert(staleProduct, {
      discoveredAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      discoveredForIntentId: 'intent-1',
      evaluationId: 'pe-stale',
      decision: 'ALLOW',
      confirmationRequired: false,
      userId: TEST_USER.id,
    });
    const staleSnapshot = await productRepo.getSnapshotForIntent(
      'intent-1',
      staleProduct.source,
      staleProduct.id,
      TEST_USER.id,
    );
    expect(staleSnapshot).not.toBeNull();
    await selectionRepo.select({
      id: 'sel-stale-policy',
      userId: TEST_USER.id,
      intentId: 'intent-1',
      snapshotId: staleSnapshot!.id,
      source: staleProduct.source,
      productId: staleProduct.id,
      price: staleSnapshot!.price,
      currency: staleSnapshot!.currency,
      isActive: true,
      selectedAt: new Date().toISOString(),
      supersededAt: null,
    });

    const res = await post('/api/v1/policy/evaluate', {
      intentId: 'intent-1',
      productId: 'demo-nike-pegasus-100',
      ...decoyBody,
    });

    expect(res.status).toBe(410);
    expect(await json<{ error: string }>(res)).toEqual({ error: 'STALE_SNAPSHOT' });
    expect(policyRepo.evaluations).toHaveLength(0);
    expect(evidenceRepo.records).toHaveLength(0);
  });

  it('rejects a snapshot whose intent binding conflicts with the selection', async () => {
    await seedIntent('intent-1', TEST_USER.id, allowIntent);
    await seedActiveSelection('intent-1', demoProduct());
    const original = productRepo.getSnapshotById.bind(productRepo);
    const spy = vi
      .spyOn(productRepo, 'getSnapshotById')
      .mockImplementation(async (snapshotId, userId) => {
        const snapshot = await original(snapshotId, userId);
        // Same id and owner, but a different intent: defense-in-depth must reject
        // rather than evaluate a snapshot that is not bound to this selection.
        return snapshot ? { ...snapshot, intentId: 'conflicting-intent' } : null;
      });

    try {
      const res = await post('/api/v1/policy/evaluate', {
        intentId: 'intent-1',
        productId: 'demo-nike-pegasus-100',
        ...decoyBody,
      });

      expect(res.status).toBe(409);
      expect(await json<{ error: string }>(res)).toEqual({
        error: 'SELECTION_SNAPSHOT_MISMATCH',
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(policyRepo.evaluations).toHaveLength(0);
      expect(
        evidenceRepo.records.filter((r) => r.eventType === 'POLICY_EVALUATED'),
      ).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects when the active selection changes before the evaluation is persisted', async () => {
    await seedIntent('intent-1', TEST_USER.id, allowIntent);
    const first = await seedActiveSelection('intent-1', demoProduct());

    // A second, distinct snapshot for the same product, used to supersede the
    // initial selection at the pre-persist re-read boundary.
    const replacementProduct = demoProduct({ price: 89 });
    await productRepo.upsert(replacementProduct, {
      discoveredAt: new Date().toISOString(),
      discoveredForIntentId: 'intent-1',
      evaluationId: 'pe-replacement',
      decision: 'ALLOW',
      confirmationRequired: false,
      userId: TEST_USER.id,
    });
    const replacement = await productRepo.getSnapshotForIntent(
      'intent-1',
      replacementProduct.source,
      replacementProduct.id,
      TEST_USER.id,
    );
    expect(replacement).not.toBeNull();
    expect(replacement!.id).not.toBe(first.snapshotId);

    const originalGetActive = selectionRepo.getActive.bind(selectionRepo);
    let reads = 0;
    const spy = vi
      .spyOn(selectionRepo, 'getActive')
      .mockImplementation(async (intentId, userId) => {
        reads += 1;
        if (reads === 1) return originalGetActive(intentId, userId);
        if (reads === 2) {
          // The user switches selection after the route's initial read. The real
          // repository supersedes S1 and activates S2; nothing is mocked inside
          // the store, only the timing of the second read is controlled.
          const outcome = await selectionRepo.select({
            id: 'sel-replacement',
            userId,
            intentId,
            snapshotId: replacement!.id,
            source: replacement!.source,
            productId: replacement!.productId,
            price: replacement!.price,
            currency: replacement!.currency,
            isActive: true,
            selectedAt: new Date().toISOString(),
            supersededAt: null,
          });
          expect(outcome.kind).toBe('ACTIVATED');
          return outcome.selection;
        }
        return originalGetActive(intentId, userId);
      });

    try {
      const res = await post('/api/v1/policy/evaluate', {
        intentId: 'intent-1',
        productId: 'demo-nike-pegasus-100',
        ...decoyBody,
      });

      expect(res.status).toBe(409);
      expect(await json<{ error: string }>(res)).toEqual({ error: 'SELECTION_CHANGED' });
      expect(spy).toHaveBeenCalledTimes(2);
      expect(policyRepo.evaluations).toHaveLength(0);
      expect(
        evidenceRepo.records.filter((r) => r.eventType === 'POLICY_EVALUATED'),
      ).toHaveLength(0);

      // The change really happened: S2 is the active selection and S1 was
      // superseded rather than deleted.
      const active = await originalGetActive('intent-1', TEST_USER.id);
      expect(active).not.toBeNull();
      expect(active!.id).toBe('sel-replacement');
      expect(active!.snapshotId).toBe(replacement!.id);
      const history = await selectionRepo.listHistory('intent-1', TEST_USER.id);
      expect(history).toHaveLength(2);
      expect(history.filter((row) => row.isActive)).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('HTTP regression: /products/discover', () => {
  it('runs discovery, persists allowed snapshots, and returns the flow result', async () => {
    await seedIntent('intent-discover');

    const res = await post('/api/v1/products/discover', {
      structuredIntent,
      intentId: 'intent-discover',
    });
    expect(res.status).toBe(200);

    const body = await json<{
      intentId: string;
      decision: string;
      selectedProduct: { id: string } | null;
      allowed: unknown[];
    }>(res);
    expect(body.intentId).toBe('intent-discover');
    expect(body.decision).toBe('ALLOW');
    expect(body.selectedProduct?.id).toBe('demo-nike-pegasus-100');
    expect(body.allowed).toHaveLength(1);

    // The allowed offer was stored as an authoritative shared offer plus an
    // independent association for this intent.
    const offer = await productRepo.getOffer('demo_catalog', 'demo-nike-pegasus-100');
    const stored = await productRepo.getForIntent(
      'intent-discover',
      'demo_catalog',
      'demo-nike-pegasus-100',
    );
    expect(offer).not.toBeNull();
    expect(stored).not.toBeNull();
    expect(stored!.discoveredForIntentId).toBe('intent-discover');

    // Policy evaluations were persisted under the caller and evidence recorded.
    expect(policyRepo.evaluations.length).toBeGreaterThan(0);
    for (const evaluation of policyRepo.evaluations) {
      expect(policyRepo.userIdFor(evaluation.id)).toBe(TEST_USER.id);
    }
    // PRODUCT_SELECTED is emitted only by the explicit selection route, not by
    // discovery. An AI recommendation or fallback must not create a
    // user-selection evidence event.
    expect(
      evidenceRepo.records.some((r) => r.eventType === 'PRODUCT_SELECTED'),
    ).toBe(false);
  });

  it('keeps both discovery associations when two intents discover the same product', async () => {
    await seedIntent('intent-a');
    await seedIntent('intent-b');

    for (const intentId of ['intent-a', 'intent-b']) {
      const res = await post('/api/v1/products/discover', { structuredIntent, intentId });
      expect(res.status).toBe(200);
    }

    const first = await productRepo.getForIntent(
      'intent-a',
      'demo_catalog',
      'demo-nike-pegasus-100',
    );
    const second = await productRepo.getForIntent(
      'intent-b',
      'demo_catalog',
      'demo-nike-pegasus-100',
    );
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.discoveredForIntentId).toBe('intent-a');
    expect(second!.discoveredForIntentId).toBe('intent-b');
  });

  it('resolves the structured intent from a stored intent when omitted', async () => {
    const createdRes = await post('/api/v1/intent', {
      rawInput: 'running shoes',
      structured: structuredIntent,
    });
    const created = await json<{ id: string }>(createdRes);

    const res = await post('/api/v1/products/discover', { intentId: created.id });
    expect(res.status).toBe(200);
    expect((await json<{ decision: string }>(res)).decision).toBe('ALLOW');
  });

  it('404s when the referenced intent id is unknown', async () => {
    const res = await post('/api/v1/products/discover', { intentId: 'missing-intent' });
    expect(res.status).toBe(404);
    expect((await json<{ error: string }>(res)).error).toBe('Intent not found');
  });

  it('404s when the intent belongs to another user (no existence leak)', async () => {
    await seedIntent('intent-other', OTHER_USER.id);

    const res = await post('/api/v1/products/discover', { intentId: 'intent-other' });
    expect(res.status).toBe(404);
    expect((await json<{ error: string }>(res)).error).toBe('Intent not found');
    expect(evidenceRepo.records).toHaveLength(0);
  });

  it('400s when neither a structured intent nor an intent id is supplied', async () => {
    const res = await post('/api/v1/products/discover', {});
    expect(res.status).toBe(400);
  });

  it('restores saved discoveries with their exact owner-scoped evaluations', async () => {
    await seedIntent('intent-discover');
    const discovered = await post('/api/v1/products/discover', {
      structuredIntent,
      intentId: 'intent-discover',
    });
    expect(discovered.status).toBe(200);

    const res = await get('/api/v1/products/discoveries/intent-discover');
    expect(res.status).toBe(200);
    const body = await json<{
      intentId: string;
      restored: boolean;
      decision: string;
      missingEvaluations: number;
      candidates: Array<{
        product: Product;
        evaluation: { id: string; result: string; ruleResults: unknown[] };
      }>;
      allowed: Array<{ product: Product }>;
      rejected: Array<{ product: Product }>;
    }>(res);
    expect(body.intentId).toBe('intent-discover');
    expect(body.restored).toBe(true);
    expect(body.decision).toBe('ALLOW');
    expect(body.missingEvaluations).toBe(0);
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0].product.id).toBe('demo-nike-pegasus-100');
    expect(body.candidates[0].evaluation.result).toBe('ALLOW');
    expect(body.candidates[0].evaluation.ruleResults.length).toBeGreaterThan(0);
    expect(body.allowed).toHaveLength(1);
    expect(body.rejected).toHaveLength(0);

    // The evaluations are the caller's, not just any evaluation for the intent.
    expect(policyRepo.userIdFor(body.candidates[0].evaluation.id)).toBe(TEST_USER.id);
  });

  it('does not reveal or restore another user discovery history', async () => {
    await seedIntent('intent-other', OTHER_USER.id);
    await post(
      '/api/v1/products/discover',
      { structuredIntent, intentId: 'intent-other' },
      otherCookie,
    );

    const foreign = await get('/api/v1/products/discoveries/intent-other');
    expect(foreign.status).toBe(404);
    expect((await json<{ error: string }>(foreign)).error).toBe('Intent not found');

    const unknown = await get('/api/v1/products/discoveries/missing');
    expect(unknown.status).toBe(404);
  });

  it('reports saved offers whose policy evaluation is unavailable instead of inventing one', async () => {
    await seedIntent('intent-partial');
    await productRepo.upsert(demoProduct(), {
      discoveredAt: '2026-10-20T10:00:00.000Z',
      discoveredForIntentId: 'intent-partial',
      evaluationId: 'missing-evaluation',
      decision: 'ALLOW',
      confirmationRequired: false,
    });

    const res = await get('/api/v1/products/discoveries/intent-partial');
    expect(res.status).toBe(200);
    const body = await json<{
      candidates: unknown[];
      missingEvaluations: number;
      decision: string;
    }>(res);
    expect(body.candidates).toEqual([]);
    expect(body.missingEvaluations).toBe(1);
    expect(body.decision).toBe('DENY');
  });
});

describe('HTTP regression: retailer handoff', () => {
  const originalEnabled = config.retailerHandoffEnabled;
  const originalHosts = config.channel3AllowedLinkHosts;

  beforeEach(() => {
    config.retailerHandoffEnabled = true;
    config.channel3AllowedLinkHosts = ['buy.trychannel3.com'];
  });

  afterEach(() => {
    config.retailerHandoffEnabled = originalEnabled;
    config.channel3AllowedLinkHosts = originalHosts;
  });

  it('requires an authenticated session for handoff', async () => {
    await seedIntent('intent-handoff');
    const snapshotId = await seedHandoffSnapshot('intent-handoff', TEST_USER.id);

    const res = await post(
      '/api/v1/products/handoff',
      {
        intentId: 'intent-handoff',
        source: 'channel3',
        productId: 'channel3:runfalcon',
        snapshotId,
      },
      null,
    );

    expect(res.status).toBe(401);
    expect((await json<{ error: string }>(res)).error).toBe('Authentication required');
    expect(
      evidenceRepo.records.filter((record) => record.eventType === 'RETAILER_HANDOFF_PREPARED'),
    ).toHaveLength(0);
  });

  it('returns 404 while the feature flag is disabled', async () => {
    await seedIntent('intent-handoff');
    const snapshotId = await seedHandoffSnapshot('intent-handoff', TEST_USER.id);
    config.retailerHandoffEnabled = false;

    const res = await post('/api/v1/products/handoff', {
      intentId: 'intent-handoff',
      source: 'channel3',
      productId: 'channel3:runfalcon',
      snapshotId,
    });
    expect(res.status).toBe(404);
    expect(evidenceRepo.records).toHaveLength(0);
  });

  it('issues the exact snapshot URL plus disclosure and records a handoff event', async () => {
    await seedIntent('intent-handoff');
    const snapshotId = await seedHandoffSnapshot('intent-handoff', TEST_USER.id);
    const offerUrl = 'https://shoebacca.com/p/runfalcon-3?aff=abc';

    const res = await post('/api/v1/products/handoff', {
      intentId: 'intent-handoff',
      source: 'channel3',
      productId: 'channel3:runfalcon',
      snapshotId,
    });
    expect(res.status).toBe(200);
    const body = await json<{
      url: string;
      disclosure: string;
      offer: {
        id: string;
        merchant: string;
        price: number;
        currency: string;
        compareAtPrice: number | null;
        maxCommissionRate: number | null;
      };
    }>(res);
    expect(body.url).toBe(offerUrl);
    expect(body.disclosure).toBe(
      'We may earn a commission when you buy through links on this page.',
    );
    expect(body.offer).toMatchObject({
      merchant: 'shoebacca.com',
      price: 44.95,
      currency: 'USD',
      compareAtPrice: 65,
      maxCommissionRate: 0.05,
    });
    expect(body.offer).not.toHaveProperty('offerUrl');

    const events = evidenceRepo.records.filter(
      (record) => record.eventType === 'RETAILER_HANDOFF_PREPARED',
    );
    expect(events).toHaveLength(1);
    expect(events[0].intentId).toBe('intent-handoff');
    expect(events[0].data).toMatchObject({
      productId: 'channel3:runfalcon',
      merchant: 'shoebacca.com',
      price: 44.95,
      currency: 'USD',
    });
    expect(JSON.stringify(events[0].data)).not.toContain(offerUrl);
  });

  it('uses the exact requested snapshot after a later re-discovery', async () => {
    await seedIntent('intent-handoff');
    const originalSnapshotId = await seedHandoffSnapshot('intent-handoff', TEST_USER.id);
    await seedHandoffSnapshot(
      'intent-handoff',
      TEST_USER.id,
      channel3Product({
        price: 59.95,
        productUrl: 'https://shoebacca.com/p/runfalcon-3?aff=new',
      }),
    );

    const res = await post('/api/v1/products/handoff', {
      intentId: 'intent-handoff',
      source: 'channel3',
      productId: 'channel3:runfalcon',
      snapshotId: originalSnapshotId,
    });
    expect(res.status).toBe(200);
    const body = await json<{ url: string; offer: { id: string; price: number } }>(res);
    expect(body.url).toBe('https://shoebacca.com/p/runfalcon-3?aff=abc');
    expect(body.offer).toMatchObject({ id: originalSnapshotId, price: 44.95 });
  });

  it('returns 502 and records no handoff when evidence persistence fails', async () => {
    await seedIntent('intent-handoff');
    const snapshotId = await seedHandoffSnapshot('intent-handoff', TEST_USER.id);
    const appendSpy = vi
      .spyOn(evidenceRepo, 'append')
      .mockRejectedValue(new Error('evidence unavailable'));

    try {
      const res = await post('/api/v1/products/handoff', {
        intentId: 'intent-handoff',
        source: 'channel3',
        productId: 'channel3:runfalcon',
        snapshotId,
      });

      expect(res.status).toBe(502);
      const body = await json<{ error: string; url?: string }>(res);
      expect(body.error).toBe('Retailer handoff could not be prepared');
      expect(body.url).toBeUndefined();
      expect(appendSpy).toHaveBeenCalledTimes(1);
      expect(
        evidenceRepo.records.filter((record) => record.eventType === 'RETAILER_HANDOFF_PREPARED'),
      ).toHaveLength(0);
    } finally {
      appendSpy.mockRestore();
    }
  });

  it('does not reveal another user intent or hand off their snapshot', async () => {
    await seedIntent('intent-foreign', OTHER_USER.id);
    const foreignSnapshotId = await seedHandoffSnapshot('intent-foreign', OTHER_USER.id);

    const foreign = await post('/api/v1/products/handoff', {
      intentId: 'intent-foreign',
      source: 'channel3',
      productId: 'channel3:runfalcon',
      snapshotId: foreignSnapshotId,
    });
    expect(foreign.status).toBe(404);
    expect(evidenceRepo.records).toHaveLength(0);

    // Owner intent, but a snapshot owned by someone else is not substituted.
    await seedIntent('intent-owner');
    const otherSnapshotId = await seedHandoffSnapshot('intent-owner', OTHER_USER.id);
    const mismatched = await post('/api/v1/products/handoff', {
      intentId: 'intent-owner',
      source: 'channel3',
      productId: 'channel3:runfalcon',
      snapshotId: otherSnapshotId,
    });
    expect(mismatched.status).toBe(409);
    expect((await json<{ code: string }>(mismatched)).code).toBe('NO_SNAPSHOT');
    expect(evidenceRepo.records).toHaveLength(0);
  });

  it('fails closed for a legacy discovery with no immutable snapshot', async () => {
    await seedIntent('intent-legacy');
    const res = await post('/api/v1/products/handoff', {
      intentId: 'intent-legacy',
      source: 'channel3',
      productId: 'channel3:runfalcon',
      snapshotId: 'snap-missing',
    });
    expect(res.status).toBe(409);
    expect((await json<{ code: string }>(res)).code).toBe('NO_SNAPSHOT');
    expect(evidenceRepo.records).toHaveLength(0);
  });

  it('does not hand off a product not associated with the owned intent', async () => {
    await seedIntent('intent-handoff');
    const snapshotId = await seedHandoffSnapshot('intent-handoff', TEST_USER.id);

    const res = await post('/api/v1/products/handoff', {
      intentId: 'intent-handoff',
      source: 'channel3',
      productId: 'channel3:not-associated',
      snapshotId,
    });

    expect(res.status).toBe(409);
    expect((await json<{ code: string }>(res)).code).toBe('SNAPSHOT_MISMATCH');
    expect(
      evidenceRepo.records.filter((record) => record.eventType === 'RETAILER_HANDOFF_PREPARED'),
    ).toHaveLength(0);
  });

  it('rejects a snapshot older than the project freshness window', async () => {
    await seedIntent('intent-stale');
    await productRepo.upsert(channel3Product(), {
      discoveredAt: '2026-10-20T10:00:00.000Z',
      discoveredForIntentId: 'intent-stale',
      evaluationId: 'pe-handoff',
      decision: 'ALLOW',
      confirmationRequired: false,
      userId: TEST_USER.id,
    });
    const snapshot = await productRepo.getSnapshotForIntent(
      'intent-stale',
      'channel3',
      'channel3:runfalcon',
      TEST_USER.id,
    );
    if (!snapshot) throw new Error('Expected stale snapshot to exist');

    const res = await post('/api/v1/products/handoff', {
      intentId: 'intent-stale',
      source: 'channel3',
      productId: 'channel3:runfalcon',
      snapshotId: snapshot.id,
    });
    expect(res.status).toBe(409);
    expect((await json<{ code: string }>(res)).code).toBe('STALE');
    expect(evidenceRepo.records).toHaveLength(0);
  });

  it('rejects HTTP, deceptive-host, credential, and redirect-parameter URLs', async () => {
    for (const offerUrl of [
      'http://shoebacca.com/p/1',
      'https://shoebacca.com.evil.example/p/1',
      'https://user:pass@shoebacca.com/p/1',
      'https://shoebacca.com/out?url=https://evil.example',
    ]) {
      await seedIntent('intent-unsafe');
      const snapshotId = await seedHandoffSnapshot(
        'intent-unsafe',
        TEST_USER.id,
        channel3Product({ productUrl: offerUrl }),
      );

      const res = await post('/api/v1/products/handoff', {
        intentId: 'intent-unsafe',
        source: 'channel3',
        productId: 'channel3:runfalcon',
        snapshotId,
      });
      expect(res.status).toBe(409);
      expect((await json<{ code: string }>(res)).code).toBe('UNSAFE_URL');
      expect(evidenceRepo.records).toHaveLength(0);

      intentRepo.clear();
      productRepo.clear();
    }
  });

  it('accepts a documented tracking host only under the configured allowlist', async () => {
    await seedIntent('intent-tracking');
    const snapshotId = await seedHandoffSnapshot(
      'intent-tracking',
      TEST_USER.id,
      channel3Product({ productUrl: 'https://buy.trychannel3.com/abc' }),
    );

    const allowed = await post('/api/v1/products/handoff', {
      intentId: 'intent-tracking',
      source: 'channel3',
      productId: 'channel3:runfalcon',
      snapshotId,
    });
    expect(allowed.status).toBe(200);

    evidenceRepo.records.length = 0;
    config.channel3AllowedLinkHosts = [];
    const rejected = await post('/api/v1/products/handoff', {
      intentId: 'intent-tracking',
      source: 'channel3',
      productId: 'channel3:runfalcon',
      snapshotId,
    });
    expect(rejected.status).toBe(409);
    expect((await json<{ code: string }>(rejected)).code).toBe('UNSAFE_URL');
    expect(evidenceRepo.records).toHaveLength(0);
  });

  it('rejects malformed request bodies with 400', async () => {
    const res = await post('/api/v1/products/handoff', { intentId: 'intent-handoff' });
    expect(res.status).toBe(400);
  });
});

describe('HTTP regression: /selections', () => {
  const selectionPath = '/api/v1/selections';

  it('requires an authenticated session', async () => {
    await seedIntent('intent-select');
    const snapshotId = await seedHandoffSnapshot('intent-select', TEST_USER.id);

    const res = await post(
      selectionPath,
      {
        intentId: 'intent-select',
        source: 'channel3',
        productId: 'channel3:runfalcon',
        snapshotId,
      },
      null,
    );
    expect(res.status).toBe(401);

    const read = await get(`${selectionPath}/intent-select`, null);
    expect(read.status).toBe(401);
  });

  it('rejects a body without a source, product id, or snapshot id', async () => {
    await seedIntent('intent-select');

    expect((await post(selectionPath, { intentId: 'intent-select' })).status).toBe(400);
    expect(
      (await post(selectionPath, { intentId: 'intent-select', source: 'nope', productId: 'x' }))
        .status,
    ).toBe(400);
    expect(
      (
        await post(selectionPath, {
          intentId: 'intent-select',
          source: 'channel3',
          productId: 'channel3:runfalcon',
        })
      ).status,
    ).toBe(400);
  });

  it('returns 404 for an unknown or another user\'s intent', async () => {
    await seedIntent('intent-foreign-selection', OTHER_USER.id);
    const foreignSnapshotId = await seedHandoffSnapshot(
      'intent-foreign-selection',
      OTHER_USER.id,
    );

    const unknown = await post(selectionPath, {
      intentId: 'intent-missing',
      source: 'channel3',
      productId: 'channel3:runfalcon',
      snapshotId: 'snap-missing',
    });
    expect(unknown.status).toBe(404);

    const foreign = await post(selectionPath, {
      intentId: 'intent-foreign-selection',
      source: 'channel3',
      productId: 'channel3:runfalcon',
      snapshotId: foreignSnapshotId,
    });
    expect(foreign.status).toBe(404);
  });

  it('refuses to select an offer with an unavailable snapshot', async () => {
    await seedIntent('intent-select');

    const res = await post(selectionPath, {
      intentId: 'intent-select',
      source: 'channel3',
      productId: 'channel3:runfalcon',
      snapshotId: 'snap-missing',
    });

    expect(res.status).toBe(409);
    expect((await json<{ code: string }>(res)).code).toBe('NO_SNAPSHOT');
  });

  it('binds the selection to the exact displayed snapshot, ignoring client values', async () => {
    await seedIntent('intent-select');
    const snapshotId = await seedHandoffSnapshot('intent-select', TEST_USER.id);

    const res = await post(selectionPath, {
      intentId: 'intent-select',
      source: 'channel3',
      productId: 'channel3:runfalcon',
      snapshotId,
      // A tampered body must not influence what is persisted.
      price: 0.01,
      currency: 'XXX',
    });

    expect(res.status).toBe(201);
    const { selection } = await json<{
      selection: { snapshotId: string; price: number; currency: string; isActive: boolean };
    }>(res);
    expect(selection.price).toBe(44.95);
    expect(selection.currency).toBe('USD');
    expect(selection.isActive).toBe(true);
    expect(selection.snapshotId).toBe(snapshotId);
  });

  it('binds the clicked snapshot even after re-discovery replaced the association', async () => {
    await seedIntent('intent-select');
    const clickedSnapshotId = await seedHandoffSnapshot('intent-select', TEST_USER.id);
    const rediscoveredSnapshotId = await seedHandoffSnapshot(
      'intent-select',
      TEST_USER.id,
      channel3Product({ price: 49.95 }),
    );
    expect(rediscoveredSnapshotId).not.toBe(clickedSnapshotId);

    const res = await post(selectionPath, {
      intentId: 'intent-select',
      source: 'channel3',
      productId: 'channel3:runfalcon',
      snapshotId: clickedSnapshotId,
    });

    expect(res.status).toBe(201);
    const { selection } = await json<{
      selection: { snapshotId: string; price: number };
    }>(res);
    expect(selection.snapshotId).toBe(clickedSnapshotId);
    expect(selection.price).toBe(44.95);

    const active = await get(`${selectionPath}/intent-select`);
    const { selection: current } = await json<{
      selection: { snapshotId: string; price: number };
    }>(active);
    expect(current.snapshotId).toBe(clickedSnapshotId);
    expect(current.price).toBe(44.95);

    // The mutable discovery association now points at the newer capture, but the
    // selection did not silently move to it.
    const association = await productRepo.getSnapshotForIntent(
      'intent-select',
      'channel3',
      'channel3:runfalcon',
      TEST_USER.id,
    );
    expect(association?.id).toBe(rediscoveredSnapshotId);
  });

  it('rejects a snapshot that does not match the requested intent, source, or product', async () => {
    await seedIntent('intent-select');
    const snapshotId = await seedHandoffSnapshot('intent-select', TEST_USER.id);

    const sourceMismatch = await post(selectionPath, {
      intentId: 'intent-select',
      source: 'demo_catalog',
      productId: 'demo-nike-pegasus-100',
      snapshotId,
    });
    expect(sourceMismatch.status).toBe(409);
    expect((await json<{ code: string }>(sourceMismatch)).code).toBe('SNAPSHOT_MISMATCH');

    const productMismatch = await post(selectionPath, {
      intentId: 'intent-select',
      source: 'channel3',
      productId: 'channel3:other',
      snapshotId,
    });
    expect(productMismatch.status).toBe(409);
    expect((await json<{ code: string }>(productMismatch)).code).toBe('SNAPSHOT_MISMATCH');

    await seedIntent('intent-other-owned');
    const otherIntentSnapshotId = await seedHandoffSnapshot(
      'intent-other-owned',
      TEST_USER.id,
    );
    const intentMismatch = await post(selectionPath, {
      intentId: 'intent-select',
      source: 'channel3',
      productId: 'channel3:runfalcon',
      snapshotId: otherIntentSnapshotId,
    });
    expect(intentMismatch.status).toBe(409);
    expect((await json<{ code: string }>(intentMismatch)).code).toBe('SNAPSHOT_MISMATCH');

    expect(await selectionRepo.getActive('intent-select', TEST_USER.id)).toBeNull();
  });

  it('rejects a foreign owner\'s snapshot without activating a selection', async () => {
    await seedIntent('intent-select');
    await seedIntent('intent-foreign-owned', OTHER_USER.id);
    const foreignSnapshotId = await seedHandoffSnapshot(
      'intent-foreign-owned',
      OTHER_USER.id,
    );

    const res = await post(selectionPath, {
      intentId: 'intent-select',
      source: 'channel3',
      productId: 'channel3:runfalcon',
      snapshotId: foreignSnapshotId,
    });

    expect(res.status).toBe(409);
    expect((await json<{ code: string }>(res)).code).toBe('NO_SNAPSHOT');
    expect(await selectionRepo.getActive('intent-select', TEST_USER.id)).toBeNull();
  });

  it('rejects a stale snapshot instead of activating it', async () => {
    await seedIntent('intent-select');
    const staleProduct = channel3Product();
    await productRepo.upsert(staleProduct, {
      discoveredAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      discoveredForIntentId: 'intent-select',
      evaluationId: 'pe-stale-selection',
      decision: 'ALLOW',
      confirmationRequired: false,
      userId: TEST_USER.id,
    });
    const staleSnapshot = await productRepo.getSnapshotForIntent(
      'intent-select',
      staleProduct.source,
      staleProduct.id,
      TEST_USER.id,
    );
    expect(staleSnapshot).not.toBeNull();

    const res = await post(selectionPath, {
      intentId: 'intent-select',
      source: staleProduct.source,
      productId: staleProduct.id,
      snapshotId: staleSnapshot!.id,
    });

    expect(res.status).toBe(410);
    expect(await json<{ code: string }>(res)).toMatchObject({
      code: 'STALE_SNAPSHOT',
    });
    expect(await selectionRepo.getActive('intent-select', TEST_USER.id)).toBeNull();
  });

  it('returns 200 when the same snapshot is already active', async () => {
    await seedIntent('intent-select');
    const snapshotId = await seedHandoffSnapshot('intent-select', TEST_USER.id);
    const body = {
      intentId: 'intent-select',
      source: 'channel3',
      productId: 'channel3:runfalcon',
      snapshotId,
    };

    expect((await post(selectionPath, body)).status).toBe(201);
    expect((await post(selectionPath, body)).status).toBe(200);

    const history = await get(`${selectionPath}/intent-select/history`);
    const { selections } = await json<{ selections: unknown[] }>(history);
    expect(selections).toHaveLength(1);
  });

  it('replaces the active selection and preserves the previous one in history', async () => {
    await seedIntent('intent-select');
    const channel3SnapshotId = await seedHandoffSnapshot('intent-select', TEST_USER.id);
    const demoSnapshotId = await seedHandoffSnapshot(
      'intent-select',
      TEST_USER.id,
      demoProduct(),
    );

    expect(
      (
        await post(selectionPath, {
          intentId: 'intent-select',
          source: 'channel3',
          productId: 'channel3:runfalcon',
          snapshotId: channel3SnapshotId,
        })
      ).status,
    ).toBe(201);

    expect(
      (
        await post(selectionPath, {
          intentId: 'intent-select',
          source: 'demo_catalog',
          productId: 'demo-nike-pegasus-100',
          snapshotId: demoSnapshotId,
        })
      ).status,
    ).toBe(201);

    const active = await get(`${selectionPath}/intent-select`);
    const { selection: current } = await json<{
      selection: { productId: string; isActive: boolean };
    }>(active);
    expect(current.productId).toBe('demo-nike-pegasus-100');
    expect(current.isActive).toBe(true);

    const history = await get(`${selectionPath}/intent-select/history`);
    const { selections } = await json<{
      selections: Array<{
        productId: string;
        isActive: boolean;
        supersededAt: string | null;
        selectedAt: string;
      }>;
    }>(history);

    expect(selections).toHaveLength(2);
    expect(selections.filter((entry) => entry.isActive)).toHaveLength(1);
    // Newest first, tolerating equal timestamps within the same millisecond.
    expect(selections[0].selectedAt >= selections[1].selectedAt).toBe(true);

    const previous = selections.find((entry) => entry.productId === 'channel3:runfalcon');
    expect(previous).toBeDefined();
    expect(previous!.isActive).toBe(false);
    expect(previous!.supersededAt).not.toBeNull();
  });

  it('restores a null selection when nothing has been chosen yet', async () => {
    await seedIntent('intent-select');

    const res = await get(`${selectionPath}/intent-select`);
    expect(res.status).toBe(200);
    expect(await json<{ selection: unknown }>(res)).toEqual({ selection: null });
  });

  it('returns 404 for reads on another user\'s intent', async () => {
    await seedIntent('intent-foreign-selection', OTHER_USER.id);
    await seedHandoffSnapshot('intent-foreign-selection', OTHER_USER.id);

    expect((await get(`${selectionPath}/intent-foreign-selection`)).status).toBe(404);
    expect((await get(`${selectionPath}/intent-foreign-selection/history`)).status).toBe(404);
  });

  it('records PRODUCT_SELECTED with exact persisted facts on activation', async () => {
    await seedIntent('intent-evidence');
    const snapshotId = await seedHandoffSnapshot('intent-evidence', TEST_USER.id);

    const res = await post(selectionPath, {
      intentId: 'intent-evidence',
      source: 'channel3',
      productId: 'channel3:runfalcon',
      snapshotId,
    });
    expect(res.status).toBe(201);

    const selected = evidenceRepo.records.filter(
      (r) => r.eventType === 'PRODUCT_SELECTED' && r.intentId === 'intent-evidence',
    );
    expect(selected).toHaveLength(1);
    expect(selected[0].actor).toBe('user');
    expect(selected[0].metadata.source).toBe('user_input');
    expect(selected[0].data).toMatchObject({
      selectionId: expect.any(String),
      snapshotId,
      source: 'channel3',
      productId: 'channel3:runfalcon',
      price: 44.95,
      currency: 'USD',
    });
  });

  it('records PRODUCT_SELECTED idempotently on re-selection of the active snapshot', async () => {
    await seedIntent('intent-idem');
    const snapshotId = await seedHandoffSnapshot('intent-idem', TEST_USER.id);

    const first = await post(selectionPath, {
      intentId: 'intent-idem',
      source: 'channel3',
      productId: 'channel3:runfalcon',
      snapshotId,
    });
    expect(first.status).toBe(201);

    const second = await post(selectionPath, {
      intentId: 'intent-idem',
      source: 'channel3',
      productId: 'channel3:runfalcon',
      snapshotId,
    });
    expect(second.status).toBe(200);

    const selected = evidenceRepo.records.filter(
      (r) => r.eventType === 'PRODUCT_SELECTED' && r.intentId === 'intent-idem',
    );
    // The deterministic evidence ID prevents a duplicate event.
    expect(selected).toHaveLength(1);
  });

  it('returns partial success when selection succeeds but evidence persistence fails', async () => {
    await seedIntent('intent-partial');
    const snapshotId = await seedHandoffSnapshot('intent-partial', TEST_USER.id);

    const appendSpy = vi
      .spyOn(evidenceRepo, 'appendIfAbsent')
      .mockRejectedValueOnce(new Error('evidence write failed'));

    try {
      const res = await post(selectionPath, {
        intentId: 'intent-partial',
        source: 'channel3',
        productId: 'channel3:runfalcon',
        snapshotId,
      });
      // Selection persisted: not a server error.
      expect(res.status).toBe(201);
      const body = await json<{
        selection: { snapshotId: string; price: number };
        evidenceRecorded: boolean;
        evidenceError: string | null;
      }>(res);
      expect(body.evidenceRecorded).toBe(false);
      // A stable code, never the raw storage error.
      expect(body.evidenceError).toBe('EVIDENCE_PERSISTENCE_FAILED');
      expect(body.selection.snapshotId).toBe(snapshotId);
      expect(body.selection.price).toBe(44.95);
    } finally {
      appendSpy.mockRestore();
    }
  });

  it('retrying after an evidence failure records PRODUCT_SELECTED exactly once', async () => {
    await seedIntent('intent-retry');
    const snapshotId = await seedHandoffSnapshot('intent-retry', TEST_USER.id);

    // First attempt: selection succeeds, evidence fails.
    const appendSpy = vi
      .spyOn(evidenceRepo, 'appendIfAbsent')
      .mockRejectedValueOnce(new Error('evidence write failed'));
    let res = await post(selectionPath, {
      intentId: 'intent-retry',
      source: 'channel3',
      productId: 'channel3:runfalcon',
      snapshotId,
    });
    expect(res.status).toBe(201);
    const firstBody = await json<{ selection: { id: string } }>(res);
    appendSpy.mockRestore();

    // Second attempt: same snapshot → ALREADY_ACTIVE, evidence now succeeds.
    res = await post(selectionPath, {
      intentId: 'intent-retry',
      source: 'channel3',
      productId: 'channel3:runfalcon',
      snapshotId,
    });
    expect(res.status).toBe(200);
    const secondBody = await json<{ selection: { id: string } }>(res);
    // Same selection row: id is not refreshed.
    expect(secondBody.selection.id).toBe(firstBody.selection.id);

    const selected = evidenceRepo.records.filter(
      (r) => r.eventType === 'PRODUCT_SELECTED' && r.intentId === 'intent-retry',
    );
    // Deterministic ID: exactly one PRODUCT_SELECTED event across both attempts.
    expect(selected).toHaveLength(1);
    expect(selected[0].data.selectionId).toBe(firstBody.selection.id);
  });

  it('tampered client price/currency cannot alter selection evidence facts', async () => {
    await seedIntent('intent-tamper');
    const snapshotId = await seedHandoffSnapshot('intent-tamper', TEST_USER.id);

    const res = await post(selectionPath, {
      intentId: 'intent-tamper',
      source: 'channel3',
      productId: 'channel3:runfalcon',
      snapshotId,
      // Tampered values must not influence the persisted selection or evidence.
      price: 0.01,
      currency: 'XXX',
    });
    expect(res.status).toBe(201);

    const body = await json<{
      selection: { price: number; currency: string; snapshotId: string };
    }>(res);
    expect(body.selection.price).toBe(44.95);
    expect(body.selection.currency).toBe('USD');

    const selected = evidenceRepo.records.filter(
      (r) => r.eventType === 'PRODUCT_SELECTED' && r.intentId === 'intent-tamper',
    );
    expect(selected).toHaveLength(1);
    expect(selected[0].data.price).toBe(44.95);
    expect(selected[0].data.currency).toBe('USD');
  });
});

describe('HTTP regression: /evidence', () => {
  function evidenceRecord(
    id: string,
    overrides: Partial<{
      intentId: string | null;
      transactionId: string | null;
      timestamp: string;
    }> = {},
  ) {
    return {
      id,
      eventType: 'INTENT_CREATED' as const,
      timestamp: overrides.timestamp ?? '2026-10-20T10:00:00.000Z',
      actor: 'user' as const,
      transactionId: overrides.transactionId ?? null,
      intentId: overrides.intentId ?? 'intent-1',
      approvalRequestId: null,
      policyEvaluationId: null,
      data: {},
      metadata: { source: 'user_input' as const, correlationId: 'c' },
    };
  }

  async function seedEvidence() {
    await evidenceRepo.append(evidenceRecord('ev-1'), TEST_USER.id);
    await evidenceRepo.append(
      evidenceRecord('ev-2', {
        transactionId: 'tx-1',
        timestamp: '2026-10-20T10:01:00.000Z',
      }),
      TEST_USER.id,
    );
  }

  it('returns only the authenticated user evidence and filters within it', async () => {
    await seedEvidence();
    // A different user's record and a legacy ownerless record must never leak.
    await evidenceRepo.append(
      evidenceRecord('ev-other', { intentId: 'intent-other' }),
      OTHER_USER.id,
    );
    await evidenceRepo.append(evidenceRecord('ev-legacy'));

    const all = await get('/api/v1/evidence');
    expect(all.status).toBe(200);
    expect((await json<Array<{ id: string }>>(all)).map((r) => r.id)).toEqual(['ev-1', 'ev-2']);

    const byIntent = await get('/api/v1/evidence?intentId=intent-1');
    expect((await json<Array<{ id: string }>>(byIntent)).map((r) => r.id)).toEqual([
      'ev-1',
      'ev-2',
    ]);

    const byTx = await get('/api/v1/evidence?transactionId=tx-1');
    const byTxBody = await json<Array<{ id: string }>>(byTx);
    expect(byTxBody.map((r) => r.id)).toEqual(['ev-2']);

    // Another user's intent/transaction filters return nothing.
    const otherIntent = await get('/api/v1/evidence?intentId=intent-other');
    expect(await json<unknown[]>(otherIntent)).toEqual([]);
    expect(await json<unknown[]>(await get('/api/v1/evidence?intentId=legacy'))).toEqual([]);
  });

  it('retrieves a single owned record and 404s for unknown, legacy, or foreign ids', async () => {
    await seedEvidence();
    await evidenceRepo.append(evidenceRecord('ev-other'), OTHER_USER.id);
    await evidenceRepo.append(evidenceRecord('ev-legacy'));

    const found = await get('/api/v1/evidence/ev-1');
    expect(found.status).toBe(200);
    expect((await json<{ id: string }>(found)).id).toBe('ev-1');

    for (const id of ['nope', 'ev-legacy', 'ev-other']) {
      const missing = await get(`/api/v1/evidence/${id}`);
      expect(missing.status).toBe(404);
      expect((await json<{ error: string }>(missing)).error).toBe(
        'Evidence record not found',
      );
    }

    const owner = await get('/api/v1/evidence/ev-other', otherCookie);
    expect(owner.status).toBe(200);
  });

  it('returns an empty array when the user has no evidence', async () => {
    // Another user's evidence alone must not make the ledger visible.
    await evidenceRepo.append(evidenceRecord('ev-other'), OTHER_USER.id);

    const res = await get('/api/v1/evidence');
    expect(res.status).toBe(200);
    expect(await json<unknown[]>(res)).toEqual([]);
  });
});

/**
 * Payment transaction operations must go through the composition-layer
 * TransactionRepository. These tests inject an in-memory repository and mount
 * the real payments router without a database: any residual raw SQL or
 * `getDb()` call in the route would throw "Database not initialized", so a
 * clean response proves the repository seam is actually used.
 */
describe('HTTP regression: /payments transaction repository wiring', () => {
  function seedPendingTransaction(overrides: Partial<{
    id: string;
    paypalOrderId: string | null;
    financialState: string;
    ownerId: string | null;
    intentId: string;
    createdAt: string;
  }> = {}) {
    return transactionRepo.insertPending({
      id: overrides.id ?? 'tx-1',
      userId: 'ownerId' in overrides ? overrides.ownerId : TEST_USER.id,
      intentId: overrides.intentId ?? 'intent-1',
      productId: 'demo-nike-pegasus-100',
      policyEvaluationId: 'pe-1',
      paypalOrderId: 'paypalOrderId' in overrides ? overrides.paypalOrderId! : 'O-SANDBOX-1',
      paypalCaptureId: null,
      amount: 99,
      currency: 'USD',
      financialState: (overrides.financialState ?? 'PAYMENT_PENDING') as never,
      createdAt: overrides.createdAt ?? '2026-10-20T10:00:00.000Z',
      updatedAt: overrides.createdAt ?? '2026-10-20T10:00:00.000Z',
    });
  }

  it('GET /by-order/:orderId reads the owned transaction from the injected repository', async () => {
    await seedPendingTransaction();

    const res = await get('/api/v1/payments/by-order/O-SANDBOX-1');
    expect(res.status).toBe(200);
    const body = await json<{
      transactionId: string;
      intentId: string;
      financialState: string;
      amount: number;
      currency: string;
    }>(res);
    expect(body).toEqual({
      transactionId: 'tx-1',
      intentId: 'intent-1',
      financialState: 'PAYMENT_PENDING',
      amount: 99,
      currency: 'USD',
    });
  });

  it('GET /by-order/:orderId 404s for an unknown or another user order', async () => {
    await seedPendingTransaction({ ownerId: OTHER_USER.id });

    const unknown = await get('/api/v1/payments/by-order/O-UNKNOWN');
    expect(unknown.status).toBe(404);
    expect((await json<{ error: string }>(unknown)).error).toBe('Transaction not found for this PayPal order');

    const foreign = await get('/api/v1/payments/by-order/O-SANDBOX-1');
    expect(foreign.status).toBe(404);
    expect((await json<{ error: string }>(foreign)).error).toBe('Transaction not found for this PayPal order');
  });

  it('POST /capture 404s for an unknown or another user transaction (repository lookup, no SQL)', async () => {
    const missing = await post('/api/v1/payments/capture', { transactionId: 'missing' });
    expect(missing.status).toBe(404);
    expect((await json<{ error: string }>(missing)).error).toBe('Transaction not found');

    await seedPendingTransaction({ ownerId: OTHER_USER.id });
    const foreign = await post('/api/v1/payments/capture', { transactionId: 'tx-1' });
    expect(foreign.status).toBe(404);
    expect((await json<{ error: string }>(foreign)).error).toBe('Transaction not found');
  });

  it('POST /capture 409s when the transaction has no PayPal order', async () => {
    await seedPendingTransaction({ paypalOrderId: null });

    const res = await post('/api/v1/payments/capture', { transactionId: 'tx-1' });
    expect(res.status).toBe(409);
    expect((await json<{ error: string }>(res)).error).toBe('Transaction has no PayPal order');
  });

  it('POST /capture 400s on an invalid body before touching the repository', async () => {
    const res = await post('/api/v1/payments/capture', {});
    expect(res.status).toBe(400);
  });

  it('lists only the caller transactions, newest first, with optional intent filtering', async () => {
    await seedPendingTransaction({
      id: 'tx-older',
      paypalOrderId: 'O-OLDER',
      createdAt: '2026-10-20T09:00:00.000Z',
    });
    await seedPendingTransaction({
      id: 'tx-newer',
      paypalOrderId: 'O-NEWER',
      intentId: 'intent-2',
      createdAt: '2026-10-20T11:00:00.000Z',
    });
    await seedPendingTransaction({
      id: 'tx-foreign',
      paypalOrderId: 'O-FOREIGN',
      ownerId: OTHER_USER.id,
      intentId: 'intent-foreign',
      createdAt: '2026-10-20T12:00:00.000Z',
    });
    await seedPendingTransaction({
      id: 'tx-legacy',
      paypalOrderId: 'O-LEGACY',
      ownerId: null,
      createdAt: '2026-10-20T13:00:00.000Z',
    });

    const all = await get('/api/v1/payments/history?limit=10');
    expect(all.status).toBe(200);
    const allBody = await json<Array<{ id: string }>>(all);
    expect(allBody.map((transaction) => transaction.id)).toEqual(['tx-newer', 'tx-older']);

    const filtered = await get('/api/v1/payments/history?intentId=intent-1');
    expect((await json<Array<{ id: string }>>(filtered)).map((transaction) => transaction.id)).toEqual([
      'tx-older',
    ]);

    const limited = await get('/api/v1/payments/history?limit=1');
    expect((await json<Array<{ id: string }>>(limited)).map((transaction) => transaction.id)).toEqual([
      'tx-newer',
    ]);

    const foreign = await get('/api/v1/payments/history', otherCookie);
    expect((await json<Array<{ id: string }>>(foreign)).map((transaction) => transaction.id)).toEqual([
      'tx-foreign',
    ]);

    // Another owner's intent id cannot widen the caller's history scope.
    const foreignIntent = await get('/api/v1/payments/history?intentId=intent-foreign');
    expect(await json<unknown[]>(foreignIntent)).toEqual([]);
  });

  it('requires authentication for payment lookups', async () => {
    const res = await get('/api/v1/payments/by-order/O-SANDBOX-1', null);
    expect(res.status).toBe(401);
  });
});
