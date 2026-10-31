import { describe, it, expect, beforeEach } from 'vitest';
import initSqlJs from 'sql.js';
import type { Product, StructuredIntent } from '@agentproof/shared';
import {
  ProductResolutionService,
  createProductResolutionService,
  DEFAULT_PRODUCT_MAX_AGE_MS,
} from './ProductResolutionService.js';
import { SQLiteProductRepository } from './SQLiteProductRepository.js';
import { DEMO_PRODUCTS } from './DemoCatalogService.js';
type SqlJsDatabase = InstanceType<Awaited<ReturnType<typeof import('sql.js')>>['Database']>;

const sqlJsReady = initSqlJs();

let db: SqlJsDatabase;

// Fresh in-memory DB per test. DDL mirrors the `products` table in models/db.ts.
beforeEach(async () => {
  const SQL = await sqlJsReady;
  db = new SQL.Database();
  db.exec(`
    CREATE TABLE products (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      price REAL NOT NULL,
      currency TEXT NOT NULL,
      brand TEXT,
      condition TEXT,
      category TEXT,
      image_url TEXT,
      product_url TEXT,
      metadata_json TEXT,
      discovered_at TEXT NOT NULL
    );

    CREATE TABLE intent_discoveries (
      intent_id TEXT NOT NULL,
      source TEXT NOT NULL,
      product_id TEXT NOT NULL,
      discovered_at TEXT NOT NULL,
      evaluation_id TEXT,
      decision TEXT,
      confirmation_required INTEGER,
      snapshot_id TEXT,
      PRIMARY KEY (intent_id, source, product_id)
    );

    CREATE TABLE intent_offer_snapshots (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      intent_id TEXT NOT NULL,
      source TEXT NOT NULL,
      product_id TEXT NOT NULL,
      external_product_id TEXT,
      product_name TEXT NOT NULL,
      brand TEXT,
      offer_url TEXT,
      merchant TEXT,
      price REAL NOT NULL,
      currency TEXT NOT NULL,
      availability TEXT,
      condition TEXT,
      compare_at_price REAL,
      max_commission_rate REAL,
      captured_at TEXT NOT NULL
    );
  `);
});

function makeIntent(overrides: Partial<StructuredIntent> = {}): StructuredIntent {
  return {
    purpose: 'running shoes',
    maxAmount: 150,
    currency: 'USD',
    brands: ['Nike', 'Adidas'],
    condition: 'new',
    requiresConfirmationAbove: null,
    constraints: [],
    ...overrides,
  };
}

function channel3Product(overrides: Partial<Product> = {}): Product {
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
    metadata: { provider: 'channel3', offerDomain: 'shoebacca.com' },
    ...overrides,
  };
}

const FIXED_NOW = Date.parse('2026-10-20T10:30:00.000Z');
const FIXED_DISCOVERED_AT = '2026-10-20T10:00:00.000Z';

describe('SQLiteProductRepository', () => {
  it('round-trips a Channel3 snapshot including optional fields and bookkeeping', async () => {
    const repo = new SQLiteProductRepository(db);
    const product = channel3Product();
    await repo.upsert(product, { discoveredAt: FIXED_DISCOVERED_AT, discoveredForIntentId: 'intent-1' });

    const stored = await repo.getForIntent('intent-1', product.source, product.id);
    expect(stored).not.toBeNull();
    expect(stored!.product).toEqual(product);
    expect(stored!.discoveredAt).toBe(FIXED_DISCOVERED_AT);
    expect(stored!.discoveredForIntentId).toBe('intent-1');
  });

  it('refreshes an existing offer for the same id rather than duplicating it', async () => {
    const repo = new SQLiteProductRepository(db);
    await repo.upsert(channel3Product({ price: 44.95 }), {
      discoveredAt: FIXED_DISCOVERED_AT,
      discoveredForIntentId: 'intent-1',
    });
    await repo.upsert(channel3Product({ price: 39.5 }), {
      discoveredAt: '2026-10-20T10:15:00.000Z',
      discoveredForIntentId: 'intent-1',
    });

    const stored = await repo.getForIntent('intent-1', 'channel3', 'channel3:runfalcon');
    expect(stored!.product.price).toBe(39.5);
    expect(stored!.discoveredAt).toBe('2026-10-20T10:15:00.000Z');

    const countStmt = db.prepare('SELECT COUNT(*) AS n FROM products');
    countStmt.step();
    expect((countStmt.getAsObject() as unknown as { n: number }).n).toBe(1);
    countStmt.free();

    const discoveryCount = db.prepare('SELECT COUNT(*) AS n FROM intent_discoveries');
    discoveryCount.step();
    expect((discoveryCount.getAsObject() as unknown as { n: number }).n).toBe(1);
    discoveryCount.free();
  });

  it('keeps one discovery association per intent when the same offer is re-discovered', async () => {
    const repo = new SQLiteProductRepository(db);
    await repo.upsert(channel3Product(), {
      discoveredAt: FIXED_DISCOVERED_AT,
      discoveredForIntentId: 'intent-1',
    });
    await repo.upsert(channel3Product({ price: 39.5 }), {
      discoveredAt: '2026-10-20T10:15:00.000Z',
      discoveredForIntentId: 'intent-2',
    });
    await repo.upsert(channel3Product({ price: 35 }), {
      discoveredAt: '2026-10-20T10:20:00.000Z',
      discoveredForIntentId: 'intent-1',
    });

    const first = await repo.getForIntent('intent-1', 'channel3', 'channel3:runfalcon');
    const second = await repo.getForIntent('intent-2', 'channel3', 'channel3:runfalcon');
    expect(first!.discoveredAt).toBe('2026-10-20T10:20:00.000Z');
    expect(second!.discoveredAt).toBe('2026-10-20T10:15:00.000Z');
    expect(first!.product.price).toBe(35);
    expect(second!.product.price).toBe(35);

    const discoveryCount = db.prepare('SELECT COUNT(*) AS n FROM intent_discoveries');
    discoveryCount.step();
    expect((discoveryCount.getAsObject() as unknown as { n: number }).n).toBe(2);
    discoveryCount.free();
  });

  it('returns null for an unknown id', async () => {
    expect(await new SQLiteProductRepository(db).getOffer('channel3', 'channel3:missing')).toBeNull();
  });
});

describe('ProductResolutionService', () => {
  const intent = makeIntent();

  it('resolves a persisted Channel3 product for order creation', async () => {
    const repo = new SQLiteProductRepository(db);
    await repo.upsert(channel3Product(), {
      discoveredAt: new Date().toISOString(),
      discoveredForIntentId: 'intent-1',
    });

    const service = createProductResolutionService(new SQLiteProductRepository(db), 'channel3');
    const result = await service.resolve('intent-1', intent, 'channel3:runfalcon');

    expect(result.kind).toBe('RESOLVED');
    if (result.kind === 'RESOLVED') {
      expect(result.product.source).toBe('channel3');
      expect(result.product.id).toBe('channel3:runfalcon');
      expect(result.product.price).toBe(44.95);
      expect(result.product.merchant).toBe('shoebacca.com');
    }
  });

  it('rejects an unknown product id', async () => {
    const service = createProductResolutionService(new SQLiteProductRepository(db), 'channel3');
    expect((await service.resolve('intent-1', intent, 'channel3:missing')).kind).toBe('NOT_FOUND');
  });

  it('does NOT look up a Channel3 product in the demo catalog', async () => {
    // The live provider has no demo fallback: an id that only exists in the
    // demo catalog is simply not found.
    const service = createProductResolutionService(new SQLiteProductRepository(db), 'channel3');
    const demoId = DEMO_PRODUCTS[0].id;
    expect((await service.resolve('intent-1', intent, demoId)).kind).toBe('NOT_FOUND');
  });

  it('resolves from the demo catalog ONLY when the demo provider is explicitly configured', async () => {
    const demoService = createProductResolutionService(new SQLiteProductRepository(db), 'demo');
    const demoResult = await demoService.resolve('intent-1', intent, DEMO_PRODUCTS[0].id);
    expect(demoResult.kind).toBe('RESOLVED');
    if (demoResult.kind === 'RESOLVED') {
      expect(demoResult.product.source).toBe('demo_catalog');
    }

    // ...and the live provider still refuses that same id.
    const liveService = createProductResolutionService(new SQLiteProductRepository(db), 'channel3');
    expect((await liveService.resolve('intent-1', intent, DEMO_PRODUCTS[0].id)).kind).toBe('NOT_FOUND');
  });

  it('fails closed when the stored snapshot is stale', async () => {
    const repo = new SQLiteProductRepository(db);
    await repo.upsert(channel3Product(), {
      discoveredAt: FIXED_DISCOVERED_AT,
      discoveredForIntentId: 'intent-1',
    });
    const service = new ProductResolutionService({
      repository: repo,
      source: 'channel3',
      maxAgeMs: 60 * 60 * 1000,
      now: () => Date.parse('2026-10-20T12:00:00.000Z'),
    });

    expect((await service.resolve('intent-1', intent, 'channel3:runfalcon')).kind).toBe('STALE');
  });

  it('fails closed on a malformed discovered_at timestamp', async () => {
    const repo = new SQLiteProductRepository(db);
    await repo.upsert(channel3Product(), { discoveredAt: 'not-a-date', discoveredForIntentId: 'intent-1' });
    const service = new ProductResolutionService({
      repository: repo,
      source: 'channel3',
      now: () => FIXED_NOW,
    });

    expect((await service.resolve('intent-1', intent, 'channel3:runfalcon')).kind).toBe('STALE');
  });

  it('treats a corrupt stored row as unusable rather than trusting it', async () => {
    db.run(
      `INSERT INTO products (id, source, name, description, price, currency, brand, condition, category, image_url, product_url, metadata_json, discovered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['channel3:corrupt', 'channel3', 'Bad Row', '', 10, 'USD', 'adidas', 'weird', 'Running Shoes', null, null, '{}', FIXED_DISCOVERED_AT],
    );
    db.run(
      `INSERT INTO intent_discoveries
        (intent_id, source, product_id, discovered_at, evaluation_id, decision, confirmation_required)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['intent-1', 'channel3', 'channel3:corrupt', FIXED_DISCOVERED_AT, null, null, null],
    );
    const service = new ProductResolutionService({
      repository: new SQLiteProductRepository(db),
      source: 'channel3',
      now: () => FIXED_NOW,
    });

    expect((await service.resolve('intent-1', intent, 'channel3:corrupt')).kind).toBe('UNUSABLE');
  });

  it('rejects a snapshot that was discovered for a different intent', async () => {
    const repo = new SQLiteProductRepository(db);
    await repo.upsert(channel3Product(), {
      discoveredAt: FIXED_DISCOVERED_AT,
      discoveredForIntentId: 'other-intent',
    });
    const service = new ProductResolutionService({
      repository: repo,
      source: 'channel3',
      now: () => FIXED_NOW,
    });

    expect((await service.resolve('intent-1', intent, 'channel3:runfalcon')).kind).toBe('NOT_FOR_INTENT');
  });

  it('resolves the same provider product independently for two intents', async () => {
    const repo = new SQLiteProductRepository(db);
    await repo.upsert(channel3Product(), {
      discoveredAt: FIXED_DISCOVERED_AT,
      discoveredForIntentId: 'intent-1',
    });
    await repo.upsert(channel3Product({ price: 39.5 }), {
      discoveredAt: '2026-10-20T10:15:00.000Z',
      discoveredForIntentId: 'intent-2',
    });

    const service = new ProductResolutionService({
      repository: repo,
      source: 'channel3',
      now: () => FIXED_NOW,
    });

    const first = await service.resolve('intent-1', intent, 'channel3:runfalcon');
    const second = await service.resolve('intent-2', intent, 'channel3:runfalcon');
    expect(first.kind).toBe('RESOLVED');
    expect(second.kind).toBe('RESOLVED');
  });

  it('returns the authoritative offer (server price/currency), not client input', async () => {
    const repo = new SQLiteProductRepository(db);
    await repo.upsert(channel3Product({ price: 44.95, currency: 'USD' }), {
      discoveredAt: FIXED_DISCOVERED_AT,
      discoveredForIntentId: 'intent-1',
    });
    const service = new ProductResolutionService({
      repository: repo,
      source: 'channel3',
      now: () => FIXED_NOW,
    });

    const result = await service.resolve('intent-1', intent, 'channel3:runfalcon');
    expect(result.kind).toBe('RESOLVED');
    if (result.kind === 'RESOLVED') {
      expect(result.product.price).toBe(44.95);
      expect(result.product.currency).toBe('USD');
    }
  });

  it('does not fabricate offer details for a legacy association with no snapshot', async () => {
    db.run(
      `INSERT INTO products (id, source, name, description, price, currency, brand, condition, category, image_url, product_url, metadata_json, discovered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['channel3:legacy', 'channel3', 'Legacy Row', '', 10, 'USD', 'adidas', 'new', 'Running Shoes', null, 'https://shoebacca.com/p/legacy', '{}', FIXED_DISCOVERED_AT],
    );
    db.run(
      `INSERT INTO intent_discoveries
        (intent_id, source, product_id, discovered_at, evaluation_id, decision, confirmation_required)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['intent-1', 'channel3', 'channel3:legacy', FIXED_DISCOVERED_AT, null, 'ALLOW', 0],
    );
    const repo = new SQLiteProductRepository(db);

    await expect(
      repo.getSnapshotForIntent('intent-1', 'channel3', 'channel3:legacy', 'user-1'),
    ).resolves.toBeNull();
    const entries = await repo.listForIntent('intent-1', 'user-1');
    expect(entries[0].snapshot).toBeNull();
  });

  it('exposes a positive default freshness window', () => {
    expect(DEFAULT_PRODUCT_MAX_AGE_MS).toBeGreaterThan(0);
  });
});
