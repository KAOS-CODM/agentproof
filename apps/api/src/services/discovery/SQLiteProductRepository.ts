import type { Product } from '@agentproof/shared';
import type { DiscoveryDecision, IntentDiscovery } from './IntentDiscoveryRepository.js';
import type {
  IntentDiscoveredProduct,
  ProductRepository,
  ProductUpsertMeta,
  StoredProduct,
} from './ProductRepository.js';
import {
  createOfferSnapshot,
  type OfferSnapshot,
} from './OfferSnapshot.js';

type SqlJsDatabase = InstanceType<Awaited<ReturnType<typeof import('sql.js')>>['Database']>;

/**
 * Extra product fields that have no dedicated column are stored together in the
 * existing `metadata_json` column. No product-table schema migration is needed.
 */
interface StoredMetadata {
  merchant?: string;
  availability?: string;
  externalId?: string;
  brandId?: string;
  provider?: Record<string, unknown>;
}

function parseMetadata(raw: unknown): StoredMetadata {
  if (typeof raw !== 'string' || raw.length === 0) return {};
  try {
    const value = JSON.parse(raw);
    return typeof value === 'object' && value !== null ? (value as StoredMetadata) : {};
  } catch {
    return {};
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function rowToProduct(row: Record<string, unknown>): Product {
  const metadata = parseMetadata(row.metadata_json);

  const candidate: Record<string, unknown> = {
    id: row.id,
    source: row.source,
    name: row.name,
    description: asString(row.description) ?? '',
    price: row.price,
    currency: row.currency,
    brand: asString(row.brand) ?? '',
    condition: row.condition,
    category: asString(row.category) ?? '',
  };

  const imageUrl = asString(row.image_url);
  if (imageUrl !== null) candidate.imageUrl = imageUrl;
  const productUrl = asString(row.product_url);
  if (productUrl !== null) candidate.productUrl = productUrl;
  if (metadata.merchant !== undefined) candidate.merchant = metadata.merchant;
  if (metadata.availability !== undefined) candidate.availability = metadata.availability;
  if (metadata.externalId !== undefined) candidate.externalId = metadata.externalId;
  if (metadata.brandId !== undefined) candidate.brandId = metadata.brandId;
  if (metadata.provider !== undefined) candidate.metadata = metadata.provider;

  // Typed as Product, but intentionally not validated here (see resolver).
  return candidate as unknown as Product;
}

const PRODUCT_COLUMNS = `id, source, name, description, price, currency, brand, condition,
  category, image_url, product_url, metadata_json, discovered_at`;

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function rowToSnapshot(row: Record<string, unknown>): OfferSnapshot {
  return {
    id: String(row.id),
    userId: asString(row.user_id),
    intentId: String(row.intent_id),
    source: row.source as OfferSnapshot['source'],
    productId: String(row.product_id),
    externalProductId: asString(row.external_product_id),
    productName: String(row.product_name),
    brand: asString(row.brand) ?? '',
    offerUrl: asString(row.offer_url),
    merchant: asString(row.merchant),
    price: Number(row.price),
    currency: String(row.currency),
    availability: asString(row.availability) as OfferSnapshot['availability'],
    condition: asString(row.condition) as OfferSnapshot['condition'],
    compareAtPrice: asNumber(row.compare_at_price),
    maxCommissionRate: asNumber(row.max_commission_rate),
    capturedAt: String(row.captured_at),
  };
}

/**
 * SQLite (sql.js) implementation of the product repository.
 *
 * Shared offers live in the existing `products` table. Per-intent associations
 * live in `intent_discoveries` (created by `models/db.ts`), keyed by
 * `(intent_id, source, product_id)`. This keeps the two concepts independent:
 * the same product can be discovered by multiple intents, and refreshing the
 * shared offer row does not delete any discovery association.
 *
 * Existing SQLite installations used `products.id` as the primary key, so
 * provider identity cannot be part of that table's key without a destructive
 * migration. The adapter therefore scopes reads by `(source, id)` but treats
 * the product id as unique within this legacy table, as it always has.
 *
 * `getOffer`/`getForIntent` reconstruct a best-effort `Product` from stored
 * columns. They do NOT validate the shape - validation is the resolver's job -
 * so a corrupt/tampered row surfaces as an unusable product rather than
 * silently disappearing as "not found".
 */
export class SQLiteProductRepository implements ProductRepository {
  constructor(private readonly db: SqlJsDatabase) {}

  async upsert(product: Product, meta: ProductUpsertMeta): Promise<void> {
    const metadata: StoredMetadata = {
      merchant: product.merchant,
      availability: product.availability,
      externalId: product.externalId,
      brandId: product.brandId,
      provider: product.metadata,
    };

    this.db.run(
      `INSERT OR REPLACE INTO products
        (id, source, name, description, price, currency, brand, condition, category, image_url, product_url, metadata_json, discovered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        product.id,
        product.source,
        product.name,
        product.description,
        product.price,
        product.currency,
        product.brand,
        product.condition,
        product.category,
        product.imageUrl ?? null,
        product.productUrl ?? null,
        JSON.stringify(metadata),
        meta.discoveredAt,
      ],
    );

    const intentId = meta.discoveredForIntentId ?? null;
    if (intentId === null) return;

    // Append-only: each discovery captures a new immutable snapshot. The
    // association points at this discovery's snapshot, so a later refresh of
    // the shared offer row can never rewrite what an earlier workflow saw.
    const snapshot = createOfferSnapshot(product, {
      intentId,
      userId: meta.userId ?? null,
      capturedAt: meta.discoveredAt,
    });
    this.insertSnapshot(snapshot);

    this.upsertDiscovery({
      intentId,
      source: product.source,
      productId: product.id,
      discoveredAt: meta.discoveredAt,
      evaluationId: meta.evaluationId ?? null,
      decision: meta.decision ?? null,
      confirmationRequired: meta.confirmationRequired ?? null,
      snapshotId: snapshot.id,
    });
  }

  async getOffer(source: Product['source'], productId: string): Promise<StoredProduct | null> {
    const stmt = this.db.prepare(
      `SELECT ${PRODUCT_COLUMNS} FROM products WHERE id = ? AND source = ?`,
    );
    stmt.bind([productId, source]);
    let row: Record<string, unknown> | null = null;
    if (stmt.step()) row = stmt.getAsObject() as Record<string, unknown>;
    stmt.free();
    if (!row) return null;

    return {
      product: rowToProduct(row),
      discoveredAt: asString(row.discovered_at) ?? '',
      discoveredForIntentId: null,
    };
  }

  async getForIntent(
    intentId: string,
    source: Product['source'],
    productId: string,
  ): Promise<StoredProduct | null> {
    const stmt = this.db.prepare(
      `SELECT p.id, p.source, p.name, p.description, p.price, p.currency, p.brand,
              p.condition, p.category, p.image_url, p.product_url, p.metadata_json,
              d.discovered_at AS discovery_discovered_at
       FROM intent_discoveries d
       JOIN products p ON p.id = d.product_id AND p.source = d.source
       WHERE d.intent_id = ? AND d.source = ? AND d.product_id = ?`,
    );
    stmt.bind([intentId, source, productId]);
    let row: Record<string, unknown> | null = null;
    if (stmt.step()) row = stmt.getAsObject() as Record<string, unknown>;
    stmt.free();
    if (!row) return null;

    return {
      product: rowToProduct(row),
      discoveredAt: asString(row.discovery_discovered_at) ?? '',
      discoveredForIntentId: intentId,
    };
  }

  async listForIntent(
    intentId: string,
    userId?: string,
  ): Promise<IntentDiscoveredProduct[]> {
    const stmt = this.db.prepare(
      `SELECT p.id, p.source, p.name, p.description, p.price, p.currency, p.brand,
              p.condition, p.category, p.image_url, p.product_url, p.metadata_json,
              d.discovered_at AS discovery_discovered_at, d.evaluation_id,
              d.decision, d.confirmation_required, d.snapshot_id
       FROM intent_discoveries d
       JOIN products p ON p.id = d.product_id AND p.source = d.source
       WHERE d.intent_id = ?
       ORDER BY d.discovered_at DESC, d.product_id ASC`,
    );
    stmt.bind([intentId]);
    const discoveries: IntentDiscoveredProduct[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      const decision =
        typeof row.decision === 'string' ? (row.decision as DiscoveryDecision) : null;
      const confirmationRequired =
        row.confirmation_required === null || row.confirmation_required === undefined
          ? null
          : Boolean(row.confirmation_required);
      const snapshotId = asString(row.snapshot_id);
      const snapshot = snapshotId ? this.readSnapshotRow(snapshotId, null) : null;
      discoveries.push({
        product: rowToProduct(row),
        discoveredAt: asString(row.discovery_discovered_at) ?? '',
        evaluationId: asString(row.evaluation_id),
        decision,
        confirmationRequired,
        // A legacy ownerless snapshot is not attached to an authenticated
        // caller's restored workflow; it must be re-discovered instead.
        snapshot:
          snapshot && (userId === undefined || snapshot.userId === userId)
            ? snapshot
            : null,
      });
    }
    stmt.free();
    return discoveries;
  }

  async getSnapshotForIntent(
    intentId: string,
    source: Product['source'],
    productId: string,
    userId: string,
  ): Promise<OfferSnapshot | null> {
    const stmt = this.db.prepare(
      `SELECT s.id, s.user_id, s.intent_id, s.source, s.product_id,
              s.external_product_id, s.product_name, s.brand, s.offer_url,
              s.merchant, s.price, s.currency, s.availability, s.condition,
              s.compare_at_price, s.max_commission_rate, s.captured_at
       FROM intent_discoveries d
       JOIN intent_offer_snapshots s
         ON s.id = d.snapshot_id
        AND s.intent_id = d.intent_id
        AND s.source = d.source
        AND s.product_id = d.product_id
       WHERE d.intent_id = ? AND d.source = ? AND d.product_id = ? AND s.user_id = ?`,
    );
    stmt.bind([intentId, source, productId, userId]);
    let row: Record<string, unknown> | null = null;
    if (stmt.step()) row = stmt.getAsObject() as Record<string, unknown>;
    stmt.free();
    return row ? rowToSnapshot(row) : null;
  }

  /**
   * Owner-scoped exact-id read.
   *
   * The ownership filter is part of the query, so another user's snapshot is
   * never materialized for the caller: a foreign snapshot is indistinguishable
   * from a missing one (null). This matches the fail-closed contract of
   * `getSnapshotForIntent` and is the lookup a selection-bound decision must use.
   */
  async getSnapshotById(snapshotId: string, userId: string): Promise<OfferSnapshot | null> {
    return this.readSnapshotRow(snapshotId, userId);
  }

  /**
   * Shared by-id read. `userId: null` means "any owner" and is only used by
   * `listForIntent`, which applies the per-row ownership filter itself.
   */
  private readSnapshotRow(id: string, userId: string | null): OfferSnapshot | null {
    const stmt =
      userId === null
        ? this.db.prepare(
            `SELECT id, user_id, intent_id, source, product_id, external_product_id,
                    product_name, brand, offer_url, merchant, price, currency,
                    availability, condition, compare_at_price, max_commission_rate,
                    captured_at
             FROM intent_offer_snapshots WHERE id = ?`,
          )
        : this.db.prepare(
            `SELECT id, user_id, intent_id, source, product_id, external_product_id,
                    product_name, brand, offer_url, merchant, price, currency,
                    availability, condition, compare_at_price, max_commission_rate,
                    captured_at
             FROM intent_offer_snapshots WHERE id = ? AND user_id = ?`,
          );
    stmt.bind(userId === null ? [id] : [id, userId]);
    let row: Record<string, unknown> | null = null;
    if (stmt.step()) row = stmt.getAsObject() as Record<string, unknown>;
    stmt.free();
    return row ? rowToSnapshot(row) : null;
  }

  private insertSnapshot(snapshot: OfferSnapshot): void {
    this.db.run(
      `INSERT INTO intent_offer_snapshots
        (id, user_id, intent_id, source, product_id, external_product_id,
         product_name, brand, offer_url, merchant, price, currency, availability,
         condition, compare_at_price, max_commission_rate, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshot.id,
        snapshot.userId,
        snapshot.intentId,
        snapshot.source,
        snapshot.productId,
        snapshot.externalProductId,
        snapshot.productName,
        snapshot.brand,
        snapshot.offerUrl,
        snapshot.merchant,
        snapshot.price,
        snapshot.currency,
        snapshot.availability,
        snapshot.condition,
        snapshot.compareAtPrice,
        snapshot.maxCommissionRate,
        snapshot.capturedAt,
      ],
    );
  }

  private upsertDiscovery(discovery: IntentDiscovery): void {
    this.db.run(
      `INSERT INTO intent_discoveries
        (intent_id, source, product_id, discovered_at, evaluation_id, decision, confirmation_required, snapshot_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(intent_id, source, product_id) DO UPDATE SET
         discovered_at = excluded.discovered_at,
         evaluation_id = excluded.evaluation_id,
         decision = excluded.decision,
         confirmation_required = excluded.confirmation_required,
         snapshot_id = excluded.snapshot_id`,
      [
        discovery.intentId,
        discovery.source,
        discovery.productId,
        discovery.discoveredAt,
        discovery.evaluationId,
        discovery.decision,
        discovery.confirmationRequired === null ? null : discovery.confirmationRequired ? 1 : 0,
        discovery.snapshotId ?? null,
      ],
    );
  }
}

// Keep the decision type referenced for SQLite storage mapping.
export type { DiscoveryDecision };
