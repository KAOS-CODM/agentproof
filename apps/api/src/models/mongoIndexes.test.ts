import { describe, it, expect } from 'vitest';
import type { IndexDescription } from 'mongodb';
import {
  ensureIndexes,
  indexPlansForPhase,
  MONGO_COLLECTION_INDEXES,
  MONGO_PHASES,
} from './mongoIndexes.js';
import type { MongoDbLike } from './mongoClient.js';

interface IndexCall {
  collection: string;
  indexes: IndexDescription[];
}

function recordingDb(): { db: MongoDbLike; calls: IndexCall[] } {
  const calls: IndexCall[] = [];
  const db: MongoDbLike = {
    command: async () => ({ ok: 1 }),
    collection: (name: string) => ({
      createIndexes: async (indexes: IndexDescription[]) => {
        calls.push({ collection: name, indexes });
        return indexes.map((i) => i.name ?? 'idx');
      },
    }),
  };
  return { db, calls };
}

function planFor(collection: string) {
  return MONGO_COLLECTION_INDEXES.find((p) => p.collection === collection);
}

function keyOf(index: IndexDescription): Record<string, unknown> {
  return index.key instanceof Map
    ? Object.fromEntries(index.key)
    : (index.key as Record<string, unknown>);
}

describe('mongo index catalog', () => {
  it('documents every planned collection with a purpose, a phase, and at least one index', () => {
    expect(MONGO_COLLECTION_INDEXES.length).toBeGreaterThan(0);
    for (const plan of MONGO_COLLECTION_INDEXES) {
      expect(plan.purpose.trim().length).toBeGreaterThan(0);
      expect(plan.indexes.length).toBeGreaterThan(0);
      expect(MONGO_PHASES).toContain(plan.phase);
    }
  });

  it('covers exactly the collections from the approved migration model', () => {
    const names = [...new Set(MONGO_COLLECTION_INDEXES.map((p) => p.collection))].sort();
    expect(names).toEqual(
      [
        'evidenceRecords',
        'intentDiscoveries',
        'intentOfferSnapshots',
        'intentSelections',
        'intents',
        'offers',
        'orderAttempts',
        'policyEvaluations',
        'purchaseApprovals',
        'sessions',
        'transactions',
        'users',
      ].sort(),
    );
  });

  it('owns exactly the P2-B collections', () => {
    expect(indexPlansForPhase('P2-B').map((p) => p.collection).sort()).toEqual(
      ['evidenceRecords', 'intents', 'policyEvaluations', 'transactions'].sort(),
    );
  });

  it('owns exactly the P3 collections', () => {
    expect(indexPlansForPhase('P3').map((p) => p.collection).sort()).toEqual(
      ['intentDiscoveries', 'intentOfferSnapshots', 'offers'].sort(),
    );
  });

  it('owns exactly the P4 collections', () => {
    expect(indexPlansForPhase('P4').map((p) => p.collection).sort()).toEqual(
      ['sessions', 'users'].sort(),
    );
  });

  it('P5 adds only the per-user evidence index', () => {
    const plans = indexPlansForPhase('P5');
    expect(plans.map((p) => p.collection)).toEqual(['evidenceRecords']);
    expect(plans[0].indexes).toEqual([
      { key: { userId: 1, timestamp: -1 }, name: 'by_user_recent' },
    ]);
  });

  it('keeps P3 and P4 collections out of P2-B', () => {
    const p2b = indexPlansForPhase('P2-B').map((p) => p.collection);
    for (const other of [
      'users',
      'sessions',
      'offers',
      'intentDiscoveries',
      'intentOfferSnapshots',
    ]) {
      expect(p2b).not.toContain(other);
    }
  });

  it('keeps P4 collections out of P3', () => {
    const p3 = indexPlansForPhase('P3').map((p) => p.collection);
    for (const p4 of ['users', 'sessions']) {
      expect(p3).not.toContain(p4);
    }
  });

  it('keeps P2-B and P3 collections out of P4', () => {
    const p4 = indexPlansForPhase('P4').map((p) => p.collection);
    for (const other of [
      'evidenceRecords',
      'intents',
      'policyEvaluations',
      'transactions',
      'offers',
      'intentDiscoveries',
      'intentOfferSnapshots',
    ]) {
      expect(p4).not.toContain(other);
    }
  });

  it('keeps evidence append-only: no TTL on any evidenceRecords index', () => {
    const plan = planFor('evidenceRecords');
    expect(plan).toBeDefined();
    for (const index of plan!.indexes) {
      expect(index.expireAfterSeconds).toBeUndefined();
    }
  });

  it('applies a TTL to sessions for expiry cleanup', () => {
    const plan = planFor('sessions');
    const ttl = plan!.indexes.find((i) => i.expireAfterSeconds !== undefined);
    expect(ttl).toBeDefined();
    expect(ttl!.name).toBe('ttl_expires');
    expect(ttl!.expireAfterSeconds).toBe(0);
    expect(ttl!.key).toEqual({ expiresAt: 1 });
  });

  it('enforces unique session token hashes and indexes session lookup by owner', () => {
    const sessions = planFor('sessions')!;
    const token = sessions.indexes.find((i) => i.name === 'uniq_token_hash');
    expect(token?.unique).toBe(true);
    expect(token?.key).toEqual({ tokenHash: 1 });
    expect(sessions.indexes.some((i) => i.name === 'by_user')).toBe(true);
  });

  it('enforces the shared-offer key by provider identity + product id', () => {
    const offer = planFor('offers')!.indexes.find((i) => i.name === 'uniq_source_product');
    expect(offer?.unique).toBe(true);
    expect(offer?.key).toEqual({ source: 1, productId: 1 });
  });

  it('enforces the per-intent discovery key by intent + provider + product', () => {
    const discovery = planFor('intentDiscoveries')!.indexes.find(
      (i) => i.name === 'uniq_intent_provider_product',
    );
    expect(discovery?.unique).toBe(true);
    expect(discovery?.key).toEqual({ intentId: 1, source: 1, productId: 1 });
  });

  it('indexes immutable offer snapshots by intent and owner', () => {
    const snapshot = planFor('intentOfferSnapshots')!;
    expect(snapshot.phase).toBe('P3');
    expect(snapshot.indexes.find((i) => i.name === 'by_intent_offer_recent')?.key).toEqual({
      intentId: 1,
      source: 1,
      productId: 1,
      capturedAt: -1,
    });
    expect(snapshot.indexes.find((i) => i.name === 'by_user_intent')?.key).toEqual({
      userId: 1,
      intentId: 1,
    });
    // Snapshots are insert-only; no unique key may prevent append-only history.
    expect(snapshot.indexes.some((i) => i.unique === true)).toBe(false);
  });

  it('does not invent a user index for intent discoveries', () => {
    const indexes = planFor('intentDiscoveries')!.indexes;
    expect(indexes.some((i) => keyOf(i).userId !== undefined)).toBe(false);
  });

  it('enforces the key uniqueness constraint for P4 users', () => {
    const users = planFor('users')!.indexes.find((i) => keyOf(i).email !== undefined);
    expect(users?.name).toBe('uniq_email');
    expect(users?.unique).toBe(true);
  });

  it('uses a partial unique index for paypalOrderId, not a colliding sparse index (H1)', () => {
    const tx = planFor('transactions')!.indexes.find((i) => i.name === 'uniq_paypal_order');
    expect(tx?.unique).toBe(true);
    expect(tx?.key).toEqual({ paypalOrderId: 1 });
    // A sparse index still indexes explicit nulls; the partial filter restricts
    // uniqueness to string-valued order ids so pending rows never collide.
    expect(tx?.sparse).toBeUndefined();
    expect(tx?.partialFilterExpression).toEqual({ paypalOrderId: { $type: 'string' } });
  });

  it('owns exactly the P6 collections', () => {
    expect(indexPlansForPhase('P6').map((p) => p.collection).sort()).toEqual(
      ['intentSelections', 'orderAttempts', 'purchaseApprovals'].sort(),
    );
  });

  it('enforces one active selection per intent with an explicit partial filter (P6)', () => {
    const selection = planFor('intentSelections')!.indexes.find(
      (i) => i.name === 'uniq_active_selection',
    );
    expect(selection?.unique).toBe(true);
    expect(selection?.key).toEqual({ intentId: 1 });
    // Active state is an explicit boolean, never a null/absent sentinel:
    // `$exists: false` is not a legal partialFilterExpression operator, and this
    // codebase omits optional fields instead of storing null. `{ isActive: true }`
    // is the exact MongoDB counterpart of `WHERE is_active = 1` in SQLite.
    expect(selection?.partialFilterExpression).toEqual({ isActive: true });
    // History must never be constrained: only the active row participates.
    expect(selection?.sparse).toBeUndefined();
  });

  it('keeps superseded selection history outside the uniqueness rule (P6)', () => {
    const selection = planFor('intentSelections')!;
    expect(selection.indexes.some((i) => keyOf(i).supersededAt !== undefined)).toBe(false);
    expect(selection.indexes.some((i) => keyOf(i).isActive !== undefined)).toBe(false);
  });

  it('enforces the order-attempt idempotency key per user (P6)', () => {
    const attempt = planFor('orderAttempts')!.indexes.find(
      (i) => i.name === 'uniq_user_idempotency',
    );
    expect(attempt?.unique).toBe(true);
    expect(attempt?.key).toEqual({ userId: 1, idempotencyKey: 1 });
  });

  it('never puts a TTL on approvals or selections (P6)', () => {
    for (const collection of ['purchaseApprovals', 'intentSelections', 'orderAttempts']) {
      for (const index of planFor(collection)!.indexes) {
        expect(index.expireAfterSeconds).toBeUndefined();
      }
    }
  });
});

describe('ensureIndexes', () => {
  it('creates every documented index plan when no phase is given', async () => {
    const { db, calls } = recordingDb();

    await ensureIndexes(db);

    expect(calls.map((c) => c.collection).sort()).toEqual(
      MONGO_COLLECTION_INDEXES.map((p) => p.collection).sort(),
    );
    for (const call of calls) {
      const plans = MONGO_COLLECTION_INDEXES.filter((p) => p.collection === call.collection);
      expect(plans.some((p) => JSON.stringify(p.indexes) === JSON.stringify(call.indexes))).toBe(
        true,
      );
    }
  });

  it('initializes only the collections owned by the requested phase (M2)', async () => {
    const { db, calls } = recordingDb();

    await ensureIndexes(db, 'P2-B');

    expect(calls.map((c) => c.collection).sort()).toEqual(
      ['evidenceRecords', 'intents', 'policyEvaluations', 'transactions'].sort(),
    );
    for (const other of [
      'users',
      'sessions',
      'offers',
      'intentDiscoveries',
      'intentOfferSnapshots',
    ]) {
      expect(calls.map((c) => c.collection)).not.toContain(other);
    }
  });

  it('initializes exactly the P3 collections when P3 is requested', async () => {
    const { db, calls } = recordingDb();

    await ensureIndexes(db, 'P3');

    expect(calls.map((c) => c.collection).sort()).toEqual(
      ['intentDiscoveries', 'intentOfferSnapshots', 'offers'].sort(),
    );
    for (const other of ['users', 'sessions', 'intents', 'policyEvaluations', 'transactions', 'evidenceRecords']) {
      expect(calls.map((c) => c.collection)).not.toContain(other);
    }
    for (const call of calls) {
      expect(call.indexes).toEqual(planFor(call.collection)!.indexes);
    }
  });

  it('initializes exactly the P4 collections when P4 is requested', async () => {
    const { db, calls } = recordingDb();

    await ensureIndexes(db, 'P4');

    expect(calls.map((c) => c.collection).sort()).toEqual(['sessions', 'users'].sort());
    for (const other of [
      'offers',
      'intentDiscoveries',
      'intentOfferSnapshots',
      'intents',
      'policyEvaluations',
      'transactions',
      'evidenceRecords',
    ]) {
      expect(calls.map((c) => c.collection)).not.toContain(other);
    }
    for (const call of calls) {
      expect(call.indexes).toEqual(planFor(call.collection)!.indexes);
    }
  });

  it('initializes exactly the P6 collections when P6 is requested', async () => {
    const { db, calls } = recordingDb();

    await ensureIndexes(db, 'P6');

    expect(calls.map((c) => c.collection).sort()).toEqual(
      ['intentSelections', 'orderAttempts', 'purchaseApprovals'].sort(),
    );
    for (const other of [
      'users',
      'sessions',
      'intents',
      'policyEvaluations',
      'transactions',
      'evidenceRecords',
      'offers',
      'intentDiscoveries',
      'intentOfferSnapshots',
    ]) {
      expect(calls.map((c) => c.collection)).not.toContain(other);
    }
    for (const call of calls) {
      expect(call.indexes).toEqual(planFor(call.collection)!.indexes);
    }
  });

  it('is idempotent: a second run issues the same specs and does not throw', async () => {
    const { db, calls } = recordingDb();

    await ensureIndexes(db);
    const firstRun = calls.map((c) => c.indexes);
    await ensureIndexes(db);
    const secondRun = calls.slice(firstRun.length).map((c) => c.indexes);

    expect(secondRun).toEqual(firstRun);
  });

  it('propagates an index-creation error rather than swallowing it', async () => {
    const db: MongoDbLike = {
      command: async () => ({ ok: 1 }),
      collection: () => ({
        createIndexes: async () => {
          throw new Error('IndexKeySpecsConflict');
        },
      }),
    };
    await expect(ensureIndexes(db, 'P2-B')).rejects.toThrow('IndexKeySpecsConflict');
  });
});
