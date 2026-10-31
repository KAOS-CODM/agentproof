import { describe, it, expect } from 'vitest';
import { MongoIntentRepository } from '../services/intent/MongoIntentRepository.js';
import { MongoPolicyEvaluationRepository } from '../services/policy/MongoPolicyEvaluationRepository.js';
import { MongoEvidenceRepository } from '../services/evidence/MongoEvidenceRepository.js';
import { MongoTransactionRepository } from '../services/transactions/MongoTransactionRepository.js';
import { MongoOfferRepository } from '../services/discovery/MongoOfferRepository.js';
import { MongoIntentDiscoveryRepository } from '../services/discovery/MongoIntentDiscoveryRepository.js';
import { MongoProductRepository } from '../services/discovery/MongoProductRepository.js';
import { MongoSelectionRepository } from '../services/selection/MongoSelectionRepository.js';
import { SelectionValidationError } from '../services/selection/SelectionRepository.js';
import { createFakeDb, fakeDocs, DuplicateKeyError } from './fakeMongo.js';
import type { Product } from '@agentproof/shared';

/**
 * MongoDB-adapter behaviour that is NOT part of the cross-backend contract
 * suite: document shape (omitted vs null fields), BSON Date mapping, duplicate
 * keys, and error propagation. No Atlas connection — everything runs against the
 * in-memory fake driver.
 */

const baseIntent = {
  id: 'intent-1',
  rawInput: 'Buy shoes',
  structured: {
    purpose: 'shoes',
    maxAmount: 100,
    currency: 'USD',
    brands: [],
    condition: 'any' as const,
    requiresConfirmationAbove: null,
    constraints: [],
  },
  status: 'VALIDATED' as const,
  createdAt: '2026-10-20T10:00:00.000Z',
  parsedAt: '2026-10-20T10:00:00.000Z',
  validatedAt: null,
};

describe('MongoIntentRepository', () => {
  it('stores timestamps as BSON Dates and maps them back to ISO strings', async () => {
    const db = createFakeDb();
    const repo = new MongoIntentRepository(db);

    await repo.create(baseIntent);

    const [doc] = fakeDocs(db, 'intents');
    expect(doc._id).toBe('intent-1');
    expect(doc.createdAt).toBeInstanceOf(Date);
    expect(doc.parsedAt).toBeInstanceOf(Date);
    expect(doc.validatedAt).toBeNull();

    const intent = await repo.getById('intent-1');
    expect(intent!.createdAt).toBe('2026-10-20T10:00:00.000Z');
    expect(intent!.validatedAt).toBeNull();
    expect(intent!.structured.purpose).toBe('shoes');
  });

  it('rejects a duplicate id instead of overwriting', async () => {
    const db = createFakeDb();
    const repo = new MongoIntentRepository(db);
    await repo.create(baseIntent);
    await expect(repo.create({ ...baseIntent, rawInput: 'other' })).rejects.toThrow();
    expect((await repo.getById('intent-1'))!.rawInput).toBe('Buy shoes');
  });

  it('propagates a find error rather than returning null', async () => {
    const repo = new MongoIntentRepository(createFakeDb({ failOn: 'find' }));
    await expect(repo.getById('intent-1')).rejects.toThrow('find failed');
  });
});

describe('MongoPolicyEvaluationRepository', () => {
  it('appends an evaluation as an immutable document with a Date timestamp', async () => {
    const db = createFakeDb();
    const repo = new MongoPolicyEvaluationRepository(db);

    await repo.save({
      id: 'pe-1',
      intentId: 'intent-1',
      productId: 'p-1',
      result: 'ALLOW',
      confirmationRequired: false,
      ruleResults: [],
      evaluatedAt: '2026-10-20T10:00:00.000Z',
    });

    const [doc] = fakeDocs(db, 'policyEvaluations');
    expect(doc.evaluatedAt).toBeInstanceOf(Date);
    expect(doc.result).toBe('ALLOW');
  });

  it('propagates an insert error', async () => {
    const repo = new MongoPolicyEvaluationRepository(createFakeDb({ failOn: 'insert' }));
    await expect(
      repo.save({
        id: 'pe-1',
        intentId: 'i',
        productId: 'p',
        result: 'ALLOW',
        confirmationRequired: false,
        ruleResults: [],
        evaluatedAt: '2026-10-20T10:00:00.000Z',
      }),
    ).rejects.toThrow('insert failed');
  });
});

describe('MongoEvidenceRepository', () => {
  const record = {
    id: 'ev-1',
    eventType: 'INTENT_CREATED',
    timestamp: '2026-10-20T10:00:00.000Z',
    actor: 'user' as const,
    transactionId: null,
    intentId: 'intent-1',
    approvalRequestId: null,
    policyEvaluationId: null,
    data: { a: 1 },
    metadata: { source: 'user_input', correlationId: 'c-1' },
  };

  it('stores a Date timestamp and returns ISO strings with null correlations', async () => {
    const db = createFakeDb();
    const repo = new MongoEvidenceRepository(db);
    await repo.append(record);

    const [doc] = fakeDocs(db, 'evidenceRecords');
    expect(doc.timestamp).toBeInstanceOf(Date);

    const found = await repo.getById('ev-1');
    expect(found!.timestamp).toBe('2026-10-20T10:00:00.000Z');
    expect(found!.transactionId).toBeNull();
    expect(found!.metadata.correlationId).toBe('c-1');
  });

  it('orders reads by timestamp ascending', async () => {
    const db = createFakeDb();
    const repo = new MongoEvidenceRepository(db);
    await repo.append({ ...record, id: 'ev-late', timestamp: '2026-10-20T10:02:00.000Z' });
    await repo.append({ ...record, id: 'ev-early', timestamp: '2026-10-20T10:00:00.000Z' });

    expect((await repo.getAll()).map((r) => r.id)).toEqual(['ev-early', 'ev-late']);
    expect((await repo.getByIntentId('intent-1')).map((r) => r.id)).toEqual([
      'ev-early',
      'ev-late',
    ]);
  });

  it('propagates an append error', async () => {
    const repo = new MongoEvidenceRepository(createFakeDb({ failOn: 'insert' }));
    await expect(repo.append(record)).rejects.toThrow('insert failed');
  });

  it('appendIfAbsent maps a duplicate _id to exists and preserves the original doc', async () => {
    const db = createFakeDb();
    const repo = new MongoEvidenceRepository(db);

    expect(await repo.appendIfAbsent(record)).toBe('created');
    expect(await repo.appendIfAbsent({ ...record, data: { a: 2 } })).toBe('exists');

    expect(fakeDocs(db, 'evidenceRecords')).toHaveLength(1);
    expect((await repo.getById('ev-1'))!.data).toEqual({ a: 1 });
  });

  it('appendIfAbsent propagates unrelated insert errors instead of calling them duplicates', async () => {
    const repo = new MongoEvidenceRepository(createFakeDb({ failOn: 'insert' }));
    await expect(repo.appendIfAbsent(record)).rejects.toThrow('insert failed');
  });
});

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
    imageUrl: 'https://cdn.example/runfalcon.jpg',
    productUrl: 'https://shoebacca.com/p/runfalcon-3',
    availability: 'InStock',
    externalId: '1FesGXD',
    brandId: 'brand-adidas',
    metadata: { provider: 'channel3' },
    ...overrides,
  };
}

describe('MongoOfferRepository', () => {
  it('stores shared offer data with BSON dates and maps it back', async () => {
    const db = createFakeDb();
    const repo = new MongoOfferRepository(db);

    await repo.upsert(makeProduct(), { fetchedAt: '2026-10-20T10:00:00.000Z' });

    const [doc] = fakeDocs(db, 'offers');
    expect(doc.fetchedAt).toBeInstanceOf(Date);
    expect(doc.updatedAt).toBeInstanceOf(Date);
    expect(doc.source).toBe('channel3');
    expect(doc.productId).toBe('channel3:runfalcon');

    const stored = await repo.get('channel3', 'channel3:runfalcon');
    expect(stored!.product).toEqual(makeProduct());
    expect(stored!.fetchedAt).toBe('2026-10-20T10:00:00.000Z');
  });

  it('refreshes the offer in place rather than duplicating it', async () => {
    const db = createFakeDb();
    const repo = new MongoOfferRepository(db);

    await repo.upsert(makeProduct({ price: 44.95 }), {
      fetchedAt: '2026-10-20T10:00:00.000Z',
    });
    await repo.upsert(makeProduct({ price: 39.5 }), {
      fetchedAt: '2026-10-20T10:15:00.000Z',
    });

    expect(fakeDocs(db, 'offers')).toHaveLength(1);
    const stored = await repo.get('channel3', 'channel3:runfalcon');
    expect(stored!.product.price).toBe(39.5);
    expect(stored!.fetchedAt).toBe('2026-10-20T10:15:00.000Z');
  });

  it('removes optional fields that are absent from a refreshed snapshot', async () => {
    const db = createFakeDb();
    const repo = new MongoOfferRepository(db);

    await repo.upsert(makeProduct(), { fetchedAt: '2026-10-20T10:00:00.000Z' });
    await repo.upsert(
      makeProduct({
        merchant: undefined,
        imageUrl: undefined,
        productUrl: undefined,
        availability: undefined,
        externalId: undefined,
        brandId: undefined,
        metadata: undefined,
      }),
      { fetchedAt: '2026-10-20T10:15:00.000Z' },
    );

    const [doc] = fakeDocs(db, 'offers');
    for (const key of [
      'merchant',
      'imageUrl',
      'productUrl',
      'availability',
      'externalId',
      'brandId',
      'metadata',
    ]) {
      expect(key in doc).toBe(false);
    }

    const stored = await repo.get('channel3', 'channel3:runfalcon');
    expect(stored!.product.merchant).toBeUndefined();
    expect(stored!.product.imageUrl).toBeUndefined();
    expect(stored!.product.metadata).toBeUndefined();
    expect(stored!.product.price).toBe(44.95);
    expect(stored!.fetchedAt).toBe('2026-10-20T10:15:00.000Z');
  });

  it('keys offers by provider identity + product id', async () => {
    const db = createFakeDb();
    const repo = new MongoOfferRepository(db);

    await repo.upsert(makeProduct({ id: 'same-id' }), {
      fetchedAt: '2026-10-20T10:00:00.000Z',
    });
    await repo.upsert(makeProduct({ id: 'same-id', source: 'demo_catalog', name: 'Demo' }), {
      fetchedAt: '2026-10-20T10:00:00.000Z',
    });

    expect(fakeDocs(db, 'offers')).toHaveLength(2);
    expect((await repo.get('channel3', 'same-id'))!.product.name).toBe(
      'Runfalcon 3.0 Running Shoes',
    );
    expect((await repo.get('demo_catalog', 'same-id'))!.product.name).toBe('Demo');
    expect(await repo.get('channel3', 'missing')).toBeNull();
  });

  it('retries once after a duplicate-key race and propagates unrelated update errors', async () => {
    const db = createFakeDb();
    const collection = db.collection('offers') as unknown as {
      updateOne: (...args: unknown[]) => Promise<unknown>;
    };
    const original = collection.updateOne.bind(collection);
    let calls = 0;
    collection.updateOne = async (...args: unknown[]) => {
      calls += 1;
      if (calls === 1) throw new DuplicateKeyError('concurrent insert');
      return original(...args);
    };

    const repo = new MongoOfferRepository(db);
    await expect(
      repo.upsert(makeProduct(), { fetchedAt: '2026-10-20T10:00:00.000Z' }),
    ).resolves.toBeUndefined();
    expect(calls).toBe(2);
    expect(await repo.get('channel3', 'channel3:runfalcon')).not.toBeNull();

    const failing = new MongoOfferRepository(createFakeDb({ failOn: 'update' }));
    await expect(
      failing.upsert(makeProduct(), { fetchedAt: '2026-10-20T10:00:00.000Z' }),
    ).rejects.toThrow('update failed');
  });
});

describe('MongoIntentDiscoveryRepository', () => {
  const base = {
    source: 'channel3' as const,
    productId: 'channel3:runfalcon',
    discoveredAt: '2026-10-20T10:00:00.000Z',
    evaluationId: 'pe-1',
    decision: 'ALLOW' as const,
    confirmationRequired: false,
  };

  it('stores a per-intent association without inventing a userId', async () => {
    const db = createFakeDb();
    const repo = new MongoIntentDiscoveryRepository(db);
    await repo.upsert({ intentId: 'intent-1', ...base });

    const [doc] = fakeDocs(db, 'intentDiscoveries');
    expect(doc.discoveredAt).toBeInstanceOf(Date);
    expect(doc.evaluationId).toBe('pe-1');
    expect(doc.decision).toBe('ALLOW');
    expect('userId' in doc).toBe(false);
    expect(doc.snapshotId).toBeNull();

    const stored = await repo.get('intent-1', 'channel3', 'channel3:runfalcon');
    expect(stored).toEqual({ intentId: 'intent-1', ...base, snapshotId: null });
    expect(await repo.get('intent-2', 'channel3', 'channel3:runfalcon')).toBeNull();
  });

  it('keeps independent associations for two intents and updates each in place', async () => {
    const db = createFakeDb();
    const repo = new MongoIntentDiscoveryRepository(db);

    await repo.upsert({ intentId: 'intent-1', ...base });
    await repo.upsert({ intentId: 'intent-2', ...base, discoveredAt: '2026-10-20T10:15:00.000Z' });
    await repo.upsert({
      intentId: 'intent-1',
      ...base,
      discoveredAt: '2026-10-20T10:30:00.000Z',
      evaluationId: 'pe-2',
    });

    expect(fakeDocs(db, 'intentDiscoveries')).toHaveLength(2);
    expect((await repo.get('intent-1', 'channel3', 'channel3:runfalcon'))!.discoveredAt).toBe(
      '2026-10-20T10:30:00.000Z',
    );
    expect((await repo.get('intent-2', 'channel3', 'channel3:runfalcon'))!.discoveredAt).toBe(
      '2026-10-20T10:15:00.000Z',
    );
  });

  it('lists an intent discoveries most recent first', async () => {
    const db = createFakeDb();
    const repo = new MongoIntentDiscoveryRepository(db);

    await repo.upsert({ intentId: 'intent-1', ...base });
    await repo.upsert({
      intentId: 'intent-1',
      ...base,
      productId: 'channel3:other',
      discoveredAt: '2026-10-20T10:15:00.000Z',
    });

    expect((await repo.listByIntent('intent-1')).map((d) => d.productId)).toEqual([
      'channel3:other',
      'channel3:runfalcon',
    ]);
    expect(await repo.listByIntent('missing')).toEqual([]);
  });

  it('retries once after a duplicate-key race and propagates unrelated update errors', async () => {
    const db = createFakeDb();
    const collection = db.collection('intentDiscoveries') as unknown as {
      updateOne: (...args: unknown[]) => Promise<unknown>;
    };
    const original = collection.updateOne.bind(collection);
    let calls = 0;
    collection.updateOne = async (...args: unknown[]) => {
      calls += 1;
      if (calls === 1) throw new DuplicateKeyError('concurrent insert');
      return original(...args);
    };

    const repo = new MongoIntentDiscoveryRepository(db);
    await expect(repo.upsert({ intentId: 'intent-1', ...base })).resolves.toBeUndefined();
    expect(calls).toBe(2);

    const failing = new MongoIntentDiscoveryRepository(createFakeDb({ failOn: 'update' }));
    await expect(failing.upsert({ intentId: 'intent-1', ...base })).rejects.toThrow(
      'update failed',
    );
  });
});

describe('MongoProductRepository', () => {
  it('discovers one provider product for two intents without erasing either association', async () => {
    const db = createFakeDb();
    const repo = new MongoProductRepository(db);

    await repo.upsert(makeProduct(), {
      discoveredAt: '2026-10-20T10:00:00.000Z',
      discoveredForIntentId: 'intent-1',
      evaluationId: 'pe-1',
      decision: 'ALLOW',
      confirmationRequired: false,
    });
    await repo.upsert(makeProduct({ price: 39.5 }), {
      discoveredAt: '2026-10-20T10:15:00.000Z',
      discoveredForIntentId: 'intent-2',
      evaluationId: 'pe-2',
      decision: 'ALLOW',
      confirmationRequired: true,
    });

    expect(fakeDocs(db, 'offers')).toHaveLength(1);
    expect(fakeDocs(db, 'intentDiscoveries')).toHaveLength(2);

    const first = await repo.getForIntent('intent-1', 'channel3', 'channel3:runfalcon');
    const second = await repo.getForIntent('intent-2', 'channel3', 'channel3:runfalcon');
    expect(first!.discoveredForIntentId).toBe('intent-1');
    expect(second!.discoveredForIntentId).toBe('intent-2');
    expect(first!.product.price).toBe(39.5);
    expect(second!.product.price).toBe(39.5);
  });

  it('refreshes shared offer data without deleting discovery history', async () => {
    const db = createFakeDb();
    const repo = new MongoProductRepository(db);

    await repo.upsert(makeProduct(), {
      discoveredAt: '2026-10-20T10:00:00.000Z',
      discoveredForIntentId: 'intent-1',
    });
    await repo.upsert(makeProduct({ price: 30 }), {
      discoveredAt: '2026-10-20T10:30:00.000Z',
    });

    expect(fakeDocs(db, 'intentDiscoveries')).toHaveLength(1);
    const first = await repo.getForIntent('intent-1', 'channel3', 'channel3:runfalcon');
    expect(first).not.toBeNull();
    expect(first!.product.price).toBe(30);
    expect(first!.discoveredAt).toBe('2026-10-20T10:00:00.000Z');
  });
});

describe('MongoTransactionRepository', () => {
  function makeTx(overrides: Record<string, unknown> = {}) {
    return {
      id: 'tx-1',
      intentId: 'intent-1',
      productId: 'p-1',
      policyEvaluationId: 'pe-1',
      paypalOrderId: 'O-1',
      paypalCaptureId: null,
      amount: 44.95,
      currency: 'USD',
      financialState: 'PAYMENT_PENDING' as const,
      createdAt: '2026-10-20T10:00:00.000Z',
      updatedAt: '2026-10-20T10:00:00.000Z',
      ...overrides,
    };
  }

  it('omits paypalOrderId/paypalCaptureId when absent and maps them back to null', async () => {
    const db = createFakeDb();
    const repo = new MongoTransactionRepository(db);

    await repo.insertPending(makeTx({ paypalOrderId: null }));

    const [doc] = fakeDocs(db, 'transactions');
    expect('paypalOrderId' in doc).toBe(false);
    expect('paypalCaptureId' in doc).toBe(false);

    const stored = await repo.getById('tx-1');
    expect(stored!.paypalOrderId).toBeNull();
    expect(stored!.paypalCaptureId).toBeNull();
  });

  it('allows multiple pending transactions without PayPal order ids', async () => {
    const db = createFakeDb();
    const repo = new MongoTransactionRepository(db);

    await repo.insertPending(makeTx({ id: 'tx-1', paypalOrderId: null }));
    await repo.insertPending(makeTx({ id: 'tx-2', paypalOrderId: null }));

    expect((await repo.getById('tx-1'))!.paypalOrderId).toBeNull();
    expect((await repo.getById('tx-2'))!.paypalOrderId).toBeNull();
  });

  it('rejects a duplicate transaction id', async () => {
    const db = createFakeDb();
    const repo = new MongoTransactionRepository(db);
    await repo.insertPending(makeTx());
    await expect(repo.insertPending(makeTx({ amount: 999 }))).rejects.toThrow();
    expect((await repo.getById('tx-1'))!.amount).toBe(44.95);
  });

  it('transitions once, then reports NOT_PENDING and preserves the original capture id', async () => {
    const db = createFakeDb();
    const repo = new MongoTransactionRepository(db);
    await repo.insertPending(makeTx());

    const first = await repo.completePayment({
      transactionId: 'tx-1',
      paypalCaptureId: 'CAP-1',
      updatedAt: '2026-10-20T10:05:00.000Z',
    });
    expect(first.kind).toBe('TRANSITIONED');

    const second = await repo.completePayment({
      transactionId: 'tx-1',
      paypalCaptureId: 'CAP-2',
      updatedAt: '2026-10-20T10:06:00.000Z',
    });
    expect(second.kind).toBe('NOT_PENDING');
    const stored = await repo.getById('tx-1');
    expect(stored!.financialState).toBe('PAYMENT_COMPLETED');
    expect(stored!.paypalCaptureId).toBe('CAP-1');
    expect(stored!.updatedAt).toBe('2026-10-20T10:05:00.000Z');
  });

  it('reports NOT_FOUND for an unknown transaction', async () => {
    const repo = new MongoTransactionRepository(createFakeDb());
    expect(
      (
        await repo.completePayment({
          transactionId: 'missing',
          paypalCaptureId: 'CAP',
          updatedAt: '2026-10-20T10:05:00.000Z',
        })
      ).kind,
    ).toBe('NOT_FOUND');
  });

  it('rejects a storage error on update rather than misreporting a transition', async () => {
    const repo = new MongoTransactionRepository(createFakeDb({ failOn: 'update' }));
    await expect(
      repo.completePayment({
        transactionId: 'tx-1',
        paypalCaptureId: 'CAP',
        updatedAt: '2026-10-20T10:05:00.000Z',
      }),
    ).rejects.toThrow('update failed');
  });

  it('rejects a storage error on completion re-read rather than returning NOT_FOUND', async () => {
    const repo = new MongoTransactionRepository(createFakeDb({ failOn: 'find' }));
    await expect(
      repo.completePayment({
        transactionId: 'tx-1',
        paypalCaptureId: 'CAP',
        updatedAt: '2026-10-20T10:05:00.000Z',
      }),
    ).rejects.toThrow('find failed');
  });
});

const baseSelection = {
  id: 'sel-1',
  userId: 'user-1',
  intentId: 'intent-1',
  snapshotId: 'snap-1',
  source: 'channel3' as const,
  productId: 'channel3:runfalcon',
  price: 44.95,
  currency: 'USD',
  isActive: true as const,
  selectedAt: '2026-10-20T10:00:00.000Z',
  supersededAt: null,
};

describe('MongoSelectionRepository', () => {
  it('persists an explicit isActive boolean and an explicit null supersededAt', async () => {
    const db = createFakeDb();
    const repo = new MongoSelectionRepository(db);

    await repo.select(baseSelection);

    const [doc] = fakeDocs(db, 'intentSelections');
    // The partial unique index filters on `{ isActive: true }`. An omitted field
    // would fall outside that filter, so the flag must always be written.
    expect(Object.prototype.hasOwnProperty.call(doc, 'isActive')).toBe(true);
    expect(doc.isActive).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(doc, 'supersededAt')).toBe(true);
    expect(doc.supersededAt).toBeNull();
    expect(doc.selectedAt).toBeInstanceOf(Date);
    expect((doc.selectedAt as Date).toISOString()).toBe('2026-10-20T10:00:00.000Z');
  });

  it('stamps supersededAt as a BSON Date and keeps the old document', async () => {
    const db = createFakeDb();
    const repo = new MongoSelectionRepository(db);

    await repo.select(baseSelection);
    await repo.select({
      ...baseSelection,
      id: 'sel-2',
      snapshotId: 'snap-2',
      selectedAt: '2026-10-20T10:01:00.000Z',
    });

    const docs = fakeDocs(db, 'intentSelections');
    expect(docs).toHaveLength(2);

    const original = docs.find((doc) => doc._id === 'sel-1')!;
    expect(original.isActive).toBe(false);
    expect(original.snapshotId).toBe('snap-1');
    expect(original.supersededAt).toBeInstanceOf(Date);
    expect((original.supersededAt as Date).toISOString()).toBe(
      '2026-10-20T10:01:00.000Z',
    );
  });

  it('writes no document when isActive is omitted', async () => {
    const db = createFakeDb();
    const repo = new MongoSelectionRepository(db);
    const { isActive: _omitted, ...withoutFlag } = baseSelection;

    await expect(repo.select(withoutFlag as never)).rejects.toThrow(
      SelectionValidationError,
    );
    expect(fakeDocs(db, 'intentSelections')).toHaveLength(0);
  });
});
