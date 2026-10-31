import type { IndexDescription } from 'mongodb';
import type { MongoDbLike } from './mongoClient.js';

/**
 * MongoDB index catalog — P0 foundation, phase-scoped in P2-B.
 *
 * Every collection and index below is taken from the approved read-only
 * migration audit. This file only DECLARES the model and provides an idempotent
 * initializer; it never connects and creates nothing until a later phase calls
 * `ensureIndexes()`.
 *
 * Phase scoping (P2-B, audit finding M2): `ensureIndexes()` only initializes the
 * collections a phase owns, so the app never creates empty collections for
 * unimplemented features. P2-B owns the intent/policy/evidence/transaction
 * collections, P3 owns the shared `offers` and per-intent `intentDiscoveries`
 * collections, and P4 owns the `users`/`sessions` persistence foundation. P5
 * adds the per-user evidence index and is initialized at startup after P4.
 *
 * `createIndexes` is idempotent for an *identical* specification, so re-running
 * a phase is safe. Changing a key/unique/partial-filter of an existing index
 * under the same name conflicts (IndexKeySpecsConflict/IndexOptionsConflict);
 * resolving such drift requires a deliberate, non-automatic migration — see the
 * "Index lifecycle" note at the bottom of this file.
 */

export interface CollectionIndexPlan {
  /** Target collection name. */
  collection: string;
  /** Why this collection exists and who owns/writes it. */
  purpose: string;
  /** The phase that owns this collection and may initialize its indexes. */
  phase: MongoPhase;
  /** Indexes to create for the collection. */
  indexes: IndexDescription[];
}

/**
 * Migration phases that own MongoDB collections. P2-B, P3, and P4 repositories
 * exist today; later phases are not declared here and are never initialized
 * early.
 */
export const MONGO_PHASES = ['P2-B', 'P3', 'P4', 'P5', 'P6'] as const;
export type MongoPhase = (typeof MONGO_PHASES)[number];

export const MONGO_COLLECTION_INDEXES: readonly CollectionIndexPlan[] = [
  {
    collection: 'users',
    phase: 'P4',
    purpose:
      'Accounts (phase P4). Server-authoritative identity; normal reads omit ' +
      'passwordHash. Unique email enforces one account per address.',
    indexes: [{ key: { email: 1 }, name: 'uniq_email', unique: true }],
  },
  {
    collection: 'sessions',
    phase: 'P4',
    purpose:
      'Server-side sessions (phase P4). Enables revocation and expiry; the TTL ' +
      'index auto-removes expired sessions. `expiresAt` MUST be stored as a BSON ' +
      'Date — a TTL index ignores string values. The unique token-hash index ' +
      'backs session lookup and prevents two sessions sharing a hash. Indexed by ' +
      'owner for "log out all".',
    indexes: [
      { key: { tokenHash: 1 }, name: 'uniq_token_hash', unique: true },
      { key: { userId: 1 }, name: 'by_user' },
      { key: { expiresAt: 1 }, name: 'ttl_expires', expireAfterSeconds: 0 },
    ],
  },
  {
    collection: 'intents',
    phase: 'P2-B',
    purpose:
      'Structured purchase intents (phase P2-B/P5). The optional userId records ' +
      'ownership; legacy ownerless intents are hidden from user-scoped reads.',
    indexes: [{ key: { userId: 1, createdAt: -1 }, name: 'by_user_recent' }],
  },
  {
    collection: 'offers',
    phase: 'P3',
    purpose:
      'Shared, OWNERLESS provider offers (phase P3). Authoritative ' +
      'price/currency/condition/merchant/URL live here, written only by the ' +
      'server during discovery. The unique compound key includes the provider ' +
      'identity (`source`) because product ids are provider-local, not globally ' +
      'unique. Refreshing an offer never touches intentDiscoveries.',
    indexes: [
      {
        key: { source: 1, productId: 1 },
        name: 'uniq_source_product',
        unique: true,
      },
    ],
  },
  {
    collection: 'intentDiscoveries',
    phase: 'P3',
    purpose:
      'Per-intent discovered/approved products (phase P3), replacing the scalar ' +
      '`discoveredForIntentId` that previously clobbered shared product rows. ' +
      'The unique compound key includes the intent and provider identity, so ' +
      're-discovery is an idempotent update for one intent while another ' +
      'intent retains its own association. Ownership is inherited from the ' +
      'owning intent; discovery itself is never exposed without that intent.',
    indexes: [
      {
        key: { intentId: 1, source: 1, productId: 1 },
        name: 'uniq_intent_provider_product',
        unique: true,
      },
      { key: { intentId: 1, discoveredAt: -1 }, name: 'by_intent_recent' },
    ],
  },
  {
    collection: 'intentOfferSnapshots',
    phase: 'P3',
    purpose:
      'Immutable per-intent offer snapshots (P7). Each discovery inserts a new ' +
      'document; nothing updates an existing snapshot. The association in ' +
      'intentDiscoveries points at the snapshot captured for that discovery. ' +
      'Ownership is stored redundantly for defense-in-depth and owner-scoped reads.',
    indexes: [
      {
        key: { intentId: 1, source: 1, productId: 1, capturedAt: -1 },
        name: 'by_intent_offer_recent',
      },
      { key: { userId: 1, intentId: 1 }, name: 'by_user_intent' },
    ],
  },
  {
    collection: 'policyEvaluations',
    phase: 'P2-B',
    purpose:
      'Append-only policy decisions (phase P2-B/P5). Ownership is inherited via ' +
      'the intent; the denormalized userId supports ownership-filtered reads.',
    indexes: [
      { key: { intentId: 1, evaluatedAt: 1 }, name: 'by_intent' },
      { key: { userId: 1, evaluatedAt: -1 }, name: 'by_user_recent' },
    ],
  },
  {
    collection: 'transactions',
    phase: 'P2-B',
    purpose:
      'Payment transactions (phase P2-B/P5). Owned by a user. The PARTIAL unique ' +
      'index guarantees one local transaction per real PayPal order without ' +
      'blocking transactions that have no order id yet (the field is omitted ' +
      'until an order exists, so a unique sparse index would still collide on ' +
      'explicit nulls). The others back history and intent lookup.',
    indexes: [
      {
        key: { paypalOrderId: 1 },
        name: 'uniq_paypal_order',
        unique: true,
        partialFilterExpression: { paypalOrderId: { $type: 'string' } },
      },
      { key: { userId: 1, createdAt: -1 }, name: 'by_user_recent' },
      { key: { intentId: 1 }, name: 'by_intent' },
    ],
  },
  {
    collection: 'evidenceRecords',
    phase: 'P2-B',
    purpose:
      'Append-only audit ledger (phase P2-B/P5). Indexed for the three real ' +
      'access patterns (by intent, by transaction, global recency). No TTL: ' +
      'evidence is retained indefinitely.',
    indexes: [
      { key: { intentId: 1, timestamp: 1 }, name: 'by_intent' },
      { key: { transactionId: 1, timestamp: 1 }, name: 'by_transaction' },
      { key: { timestamp: -1 }, name: 'by_timestamp' },
    ],
  },
  {
    collection: 'evidenceRecords',
    phase: 'P5',
    purpose:
      'P5 ownership index for user-scoped evidence listing.',
    indexes: [{ key: { userId: 1, timestamp: -1 }, name: 'by_user_recent' }],
  },
  {
    collection: 'intentSelections',
    phase: 'P6',
    purpose:
      'Durable, user-authored offer selection (phase P6). Rows are immutable ' +
      'except the one-way active -> superseded transition, so an approval bound ' +
      'to a selectionId never has its meaning rewritten. Active state is an ' +
      'explicit boolean, never a null/absent sentinel: a partial unique index on ' +
      '`{ isActive: true }` is the only form MongoDB can express here, since ' +
      '`$exists: false` is not a valid partialFilterExpression operator and this ' +
      'codebase omits optional fields rather than storing null. This is the exact ' +
      'counterpart of the SQLite `uniq_active_selection` index over ' +
      '`intent_id WHERE is_active = 1`.',
    indexes: [
      {
        key: { intentId: 1 },
        name: 'uniq_active_selection',
        unique: true,
        partialFilterExpression: { isActive: true },
      },
      { key: { userId: 1, intentId: 1 }, name: 'by_user_intent' },
    ],
  },
  {
    collection: 'purchaseApprovals',
    phase: 'P6',
    purpose:
      'Pre-transaction user approvals (phase P6). Not `approval_requests`: that ' +
      'collection requires a transaction id and cannot represent a decision made ' +
      'before an order exists. No TTL index — approvals are audit evidence, and ' +
      'expiry is enforced by a conditional update, not by document deletion.',
    indexes: [
      { key: { userId: 1, status: 1 }, name: 'by_user_status' },
      { key: { intentId: 1, status: 1 }, name: 'by_intent_status' },
      { key: { selectionId: 1 }, name: 'by_selection' },
    ],
  },
  {
    collection: 'orderAttempts',
    phase: 'P6',
    purpose:
      'Idempotent order-creation attempts (phase P6). The unique ' +
      '`{ userId, idempotencyKey }` index is what turns a retry into a lookup ' +
      'instead of a second PayPal order. `status` backs the startup sweep for ' +
      'attempts left RESERVED or IN_FLIGHT by a crash.',
    indexes: [
      { key: { userId: 1, idempotencyKey: 1 }, name: 'uniq_user_idempotency', unique: true },
      { key: { userId: 1, createdAt: -1 }, name: 'by_user_recent' },
      { key: { status: 1, updatedAt: 1 }, name: 'by_status' },
      { key: { transactionId: 1 }, name: 'by_transaction' },
    ],
  },
];

/** The collections owned by a single phase, in declaration order. */
export function indexPlansForPhase(phase: MongoPhase): CollectionIndexPlan[] {
  return MONGO_COLLECTION_INDEXES.filter((plan) => plan.phase === phase);
}

/**
 * Idempotently create the indexes owned by `phase` (default: every phase — used
 * only by tests/roll-ups, never by startup). Safe to call repeatedly for an
 * unchanged specification. A changed specification under the same index name
 * conflicts and will reject rather than silently replacing an index.
 */
export async function ensureIndexes(
  db: MongoDbLike,
  phase?: MongoPhase,
): Promise<void> {
  const plans = phase ? indexPlansForPhase(phase) : [...MONGO_COLLECTION_INDEXES];
  for (const plan of plans) {
    await db.collection(plan.collection).createIndexes([...plan.indexes]);
  }
}

/*
 * Index lifecycle (documented, not implemented here):
 *
 *   - Re-running an identical specification is safe (createIndexes is
 *     idempotent).
 *   - Changing a key/unique/partialFilterExpression of an existing index with
 *     the same name throws IndexKeySpecsConflict / IndexOptionsConflict.
 *   - This module NEVER drops an index automatically. Applying a spec change in
 *     a later phase requires a deliberate migration: either a versioned index
 *     name (create `uniq_x_v2`, then remove `uniq_x` by hand once deployed) or
 *     an approved one-off drop+create against a known environment. Silent
 *     destructive replacement is intentionally not provided.
 */
