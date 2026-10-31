import type {
  EvidenceRecord,
  Intent,
  PolicyEvaluation,
  Product,
  StructuredIntent,
  Transaction,
} from '@agentproof/shared';
import type { EvidenceRepository } from '../services/evidence/EvidenceRepository.js';
import type {
  IntentDiscoveredProduct,
  ProductRepository,
  ProductUpsertMeta,
  StoredProduct,
} from '../services/discovery/ProductRepository.js';
import type { IntentDiscovery } from '../services/discovery/IntentDiscoveryRepository.js';
import {
  createOfferSnapshot,
  type OfferSnapshot,
} from '../services/discovery/OfferSnapshot.js';
import type { IntentRepository, PersistedIntent } from '../services/intent/IntentRepository.js';
import type { PolicyEvaluationRepository } from '../services/policy/PolicyEvaluationRepository.js';
import type {
  CompletePaymentResult,
  CompletePaymentUpdate,
  PersistedTransaction,
  TransactionRepository,
} from '../services/transactions/TransactionRepository.js';
import type {
  PersistedUser,
  User,
  UserRepository,
  UserWithPasswordHash,
} from '../services/auth/UserRepository.js';
import { normalizeEmail } from '../services/auth/UserRepository.js';
import { hashPassword } from '../services/auth/passwordHasher.js';
import { generateId } from '../utils/id.js';
import type {
  PersistedSession,
  Session,
  SessionRepository,
} from '../services/auth/SessionRepository.js';
import { isSessionActive } from '../services/auth/SessionRepository.js';
import type {
  PersistedSelection,
  Selection,
  SelectionRepository,
  SelectOutcome,
} from '../services/selection/SelectionRepository.js';
import {
  assertNewSelection,
  assertSelectionRecord,
} from '../services/selection/SelectionRepository.js';

/**
 * Lightweight in-memory reference implementations of the P1a repositories.
 *
 * They exist so service/route tests can exercise async call chains without a
 * database, and so the repository contract suite can run against both a fake
 * and the SQLite adapter. They intentionally mirror the observable semantics of
 * the SQLite adapters (ordering, null/not-found, append-only).
 */

export class InMemoryEvidenceRepository implements EvidenceRepository {
  records: EvidenceRecord[] = [];
  private readonly owners = new Map<string, string | null>();

  async append(record: EvidenceRecord, userId?: string | null): Promise<void> {
    this.records.push(record);
    this.owners.set(record.id, userId ?? null);
  }

  async appendIfAbsent(
    record: EvidenceRecord,
    userId?: string | null,
  ): Promise<'created' | 'exists'> {
    // No await between the check and the push, so this stays atomic for the
    // single-threaded in-memory reference implementation.
    if (this.records.some((r) => r.id === record.id)) return 'exists';
    this.records.push(record);
    this.owners.set(record.id, userId ?? null);
    return 'created';
  }

  async getById(id: string): Promise<EvidenceRecord | null> {
    return this.records.find((r) => r.id === id) ?? null;
  }

  async getByIdForUser(id: string, userId: string): Promise<EvidenceRecord | null> {
    const record = this.records.find((r) => r.id === id);
    return record && this.owners.get(id) === userId ? record : null;
  }

  async getByIntentId(intentId: string): Promise<EvidenceRecord[]> {
    return this.sorted(this.records.filter((r) => r.intentId === intentId));
  }

  async getByIntentIdForUser(intentId: string, userId: string): Promise<EvidenceRecord[]> {
    return this.sorted(
      this.records.filter((r) => r.intentId === intentId && this.owners.get(r.id) === userId),
    );
  }

  async getByTransactionId(transactionId: string): Promise<EvidenceRecord[]> {
    return this.sorted(this.records.filter((r) => r.transactionId === transactionId));
  }

  async getByTransactionIdForUser(
    transactionId: string,
    userId: string,
  ): Promise<EvidenceRecord[]> {
    return this.sorted(
      this.records.filter(
        (r) => r.transactionId === transactionId && this.owners.get(r.id) === userId,
      ),
    );
  }

  async getAll(): Promise<EvidenceRecord[]> {
    return this.sorted([...this.records]);
  }

  async getAllForUser(userId: string): Promise<EvidenceRecord[]> {
    return this.sorted(this.records.filter((r) => this.owners.get(r.id) === userId));
  }

  async exists(id: string): Promise<boolean> {
    return this.records.some((r) => r.id === id);
  }

  private sorted(records: EvidenceRecord[]): EvidenceRecord[] {
    return records.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }
}

function offerKey(source: Product['source'], productId: string): string {
  return JSON.stringify([source, productId]);
}

function discoveryKey(
  intentId: string,
  source: Product['source'],
  productId: string,
): string {
  return JSON.stringify([intentId, source, productId]);
}

/**
 * In-memory reference implementation of the P3 offer/discovery split. Shared
 * offers and per-intent associations are stored separately, mirroring the
 * MongoDB and SQLite adapters' observable behavior.
 */
export class InMemoryProductRepository implements ProductRepository {
  private readonly offers = new Map<string, { product: Product; fetchedAt: string }>();
  private readonly discoveries = new Map<string, IntentDiscovery>();
  private readonly snapshots = new Map<string, OfferSnapshot>();

  /** Test helper: drop all stored offers, snapshots, and discovery associations. */
  clear(): void {
    this.offers.clear();
    this.discoveries.clear();
    this.snapshots.clear();
  }

  async upsert(product: Product, meta: ProductUpsertMeta): Promise<void> {
    this.offers.set(offerKey(product.source, product.id), {
      product: { ...product },
      fetchedAt: meta.discoveredAt,
    });

    const intentId = meta.discoveredForIntentId ?? null;
    if (intentId === null) return;

    const snapshot = createOfferSnapshot(product, {
      intentId,
      userId: meta.userId ?? null,
      capturedAt: meta.discoveredAt,
    });
    this.snapshots.set(snapshot.id, snapshot);

    this.discoveries.set(discoveryKey(intentId, product.source, product.id), {
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
    const offer = this.offers.get(offerKey(source, productId));
    if (!offer) return null;
    return {
      product: { ...offer.product },
      discoveredAt: offer.fetchedAt,
      discoveredForIntentId: null,
    };
  }

  async getForIntent(
    intentId: string,
    source: Product['source'],
    productId: string,
  ): Promise<StoredProduct | null> {
    const discovery = this.discoveries.get(discoveryKey(intentId, source, productId));
    if (!discovery) return null;
    const offer = this.offers.get(offerKey(source, productId));
    if (!offer) return null;
    return {
      product: { ...offer.product },
      discoveredAt: discovery.discoveredAt,
      discoveredForIntentId: intentId,
    };
  }

  async listForIntent(
    intentId: string,
    userId?: string,
  ): Promise<IntentDiscoveredProduct[]> {
    const entries: IntentDiscoveredProduct[] = [];
    for (const discovery of this.discoveries.values()) {
      if (discovery.intentId !== intentId) continue;
      const offer = this.offers.get(offerKey(discovery.source, discovery.productId));
      if (!offer) continue;
      const stored = discovery.snapshotId
        ? this.snapshots.get(discovery.snapshotId) ?? null
        : null;
      entries.push({
        product: { ...offer.product },
        discoveredAt: discovery.discoveredAt,
        evaluationId: discovery.evaluationId,
        decision: discovery.decision,
        confirmationRequired: discovery.confirmationRequired,
        snapshot:
          stored && (userId === undefined || stored.userId === userId) ? stored : null,
      });
    }
    return entries.sort((a, b) => b.discoveredAt.localeCompare(a.discoveredAt));
  }

  async getSnapshotForIntent(
    intentId: string,
    source: Product['source'],
    productId: string,
    userId: string,
  ): Promise<OfferSnapshot | null> {
    const discovery = this.discoveries.get(discoveryKey(intentId, source, productId));
    if (!discovery?.snapshotId) return null;
    const snapshot = this.snapshots.get(discovery.snapshotId);
    if (!snapshot) return null;
    if (
      snapshot.userId !== userId ||
      snapshot.intentId !== intentId ||
      snapshot.source !== source ||
      snapshot.productId !== productId
    ) {
      return null;
    }
    return snapshot;
  }

  async getSnapshotById(
    snapshotId: string,
    userId: string,
  ): Promise<OfferSnapshot | null> {
    const snapshot = this.snapshots.get(snapshotId);
    return snapshot && snapshot.userId === userId ? snapshot : null;
  }
}

export class InMemoryIntentRepository implements IntentRepository {
  private readonly store = new Map<string, PersistedIntent>();

  /** Test helper: drop all intents between cases. */
  clear(): void {
    this.store.clear();
  }

  /** Test helper: the trusted owner persisted alongside an intent. */
  userIdFor(id: string): string | null {
    return this.store.get(id)?.userId ?? null;
  }

  async create(intent: PersistedIntent): Promise<void> {
    this.store.set(intent.id, { ...intent });
  }

  async getById(id: string): Promise<Intent | null> {
    const intent = this.store.get(id);
    if (!intent) return null;
    return { ...intent, structured: { ...intent.structured } as StructuredIntent };
  }

  async getByIdForUser(id: string, userId: string): Promise<Intent | null> {
    const intent = this.store.get(id);
    if (!intent || intent.userId !== userId) return null;
    return { ...intent, structured: { ...intent.structured } as StructuredIntent };
  }

  async listForUser(userId: string, limit: number): Promise<Intent[]> {
    return [...this.store.values()]
      .filter((intent) => intent.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((intent) => ({
        ...intent,
        structured: { ...intent.structured } as StructuredIntent,
      }));
  }

  async getStructuredById(id: string): Promise<StructuredIntent | null> {
    const intent = this.store.get(id);
    return intent ? ({ ...intent.structured } as StructuredIntent) : null;
  }

  async getStructuredByIdForUser(
    id: string,
    userId: string,
  ): Promise<StructuredIntent | null> {
    const intent = this.store.get(id);
    if (!intent || intent.userId !== userId) return null;
    return { ...intent.structured } as StructuredIntent;
  }
}

export class InMemoryPolicyEvaluationRepository implements PolicyEvaluationRepository {
  evaluations: PolicyEvaluation[] = [];
  private readonly owners = new Map<string, string | null>();

  async save(evaluation: PolicyEvaluation, userId?: string | null): Promise<void> {
    this.evaluations.push(evaluation);
    this.owners.set(evaluation.id, userId ?? null);
  }

  async listByIntentForUser(
    intentId: string,
    userId: string,
  ): Promise<PolicyEvaluation[]> {
    return this.evaluations
      .filter(
        (evaluation) =>
          evaluation.intentId === intentId && this.owners.get(evaluation.id) === userId,
      )
      .sort((a, b) => a.evaluatedAt.localeCompare(b.evaluatedAt))
      .map((evaluation) => ({
        ...evaluation,
        ruleResults: evaluation.ruleResults.map((result) => ({ ...result })),
      }));
  }

  /** Test helper: the trusted owner persisted alongside an evaluation. */
  userIdFor(evaluationId: string): string | null {
    return this.owners.get(evaluationId) ?? null;
  }
}

/**
 * In-memory transaction repository mirroring the SQLite adapter's observable
 * semantics: unconditional pending insert (duplicate id raises), lookup by id
 * and by PayPal order id, and a single-winner conditional completion.
 */
export class InMemoryTransactionRepository implements TransactionRepository {
  private readonly store = new Map<string, Transaction>();
  private readonly owners = new Map<string, string | null>();

  /** Test helper: drop all rows between cases. */
  clear(): void {
    this.store.clear();
    this.owners.clear();
  }

  async insertPending(transaction: PersistedTransaction): Promise<void> {
    if (this.store.has(transaction.id)) {
      throw new Error(`Transaction ${transaction.id} already exists`);
    }
    this.store.set(transaction.id, { ...transaction });
    this.owners.set(transaction.id, transaction.userId ?? null);
  }

  async getById(id: string): Promise<Transaction | null> {
    const transaction = this.store.get(id);
    return transaction ? { ...transaction } : null;
  }

  async getByIdForUser(id: string, userId: string): Promise<Transaction | null> {
    const transaction = this.store.get(id);
    return transaction && this.owners.get(id) === userId ? { ...transaction } : null;
  }

  async getByPaypalOrderId(paypalOrderId: string): Promise<Transaction | null> {
    for (const transaction of this.store.values()) {
      if (transaction.paypalOrderId === paypalOrderId) return { ...transaction };
    }
    return null;
  }

  async getByPaypalOrderIdForUser(
    paypalOrderId: string,
    userId: string,
  ): Promise<Transaction | null> {
    for (const transaction of this.store.values()) {
      if (
        transaction.paypalOrderId === paypalOrderId &&
        this.owners.get(transaction.id) === userId
      ) {
        return { ...transaction };
      }
    }
    return null;
  }

  async listForUser(
    userId: string,
    limit: number,
    intentId?: string,
  ): Promise<Transaction[]> {
    return [...this.store.values()]
      .filter(
        (transaction) =>
          this.owners.get(transaction.id) === userId &&
          (intentId === undefined || transaction.intentId === intentId),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((transaction) => ({ ...transaction }));
  }

  async completePayment(update: CompletePaymentUpdate): Promise<CompletePaymentResult> {
    const current = this.store.get(update.transactionId);
    if (!current) return { kind: 'NOT_FOUND' };
    if (update.userId && this.owners.get(current.id) !== update.userId) {
      return { kind: 'NOT_FOUND' };
    }
    if (current.financialState !== 'PAYMENT_PENDING') {
      return { kind: 'NOT_PENDING', transaction: { ...current } };
    }
    const next: Transaction = {
      ...current,
      financialState: 'PAYMENT_COMPLETED',
      paypalCaptureId: update.paypalCaptureId,
      updatedAt: update.updatedAt,
    };
    this.store.set(update.transactionId, next);
    return { kind: 'TRANSITIONED', transaction: { ...next } };
  }
}

/** In-memory P4 account store with the same normalized-email uniqueness rules. */
export class InMemoryUserRepository implements UserRepository {
  private readonly users = new Map<string, PersistedUser>();
  private readonly emailIndex = new Map<string, string>();

  async create(user: PersistedUser): Promise<void> {
    const email = normalizeEmail(user.email);
    if (this.users.has(user.id)) throw new Error(`User ${user.id} already exists`);
    if (this.emailIndex.has(email)) throw new Error(`Email ${email} already exists`);
    this.users.set(user.id, { ...user, email });
    this.emailIndex.set(email, user.id);
  }

  async getById(id: string): Promise<User | null> {
    const user = this.users.get(id);
    if (!user) return null;
    return { id: user.id, email: user.email, createdAt: user.createdAt };
  }

  async getByEmail(email: string): Promise<User | null> {
    const id = this.emailIndex.get(normalizeEmail(email));
    return id ? this.getById(id) : null;
  }

  async getCredentialsByEmail(email: string): Promise<UserWithPasswordHash | null> {
    const id = this.emailIndex.get(normalizeEmail(email));
    const user = id ? this.users.get(id) : undefined;
    return user ? { ...user } : null;
  }
}

/**
 * Test-only helper: create a user with a hashed password and return the
 * credentials needed to log in. Reuses the production hasher and repository
 * contract; no production code is aware of this helper.
 */
export async function seedTestUser(
  users: InMemoryUserRepository,
  email: string,
  password: string,
): Promise<{ id: string; email: string; password: string }> {
  const normalized = normalizeEmail(email);
  const id = generateId();
  const passwordHash = await hashPassword(password);
  await users.create({
    id,
    email: normalized,
    createdAt: new Date().toISOString(),
    passwordHash,
  });
  return { id, email: normalized, password };
}

/** In-memory P4 session store with the same expiry/revocation rules. */
export class InMemorySessionRepository implements SessionRepository {
  private readonly sessions = new Map<string, Session>();

  async create(session: PersistedSession): Promise<void> {
    if (this.sessions.has(session.id)) {
      throw new Error(`Session ${session.id} already exists`);
    }
    if ([...this.sessions.values()].some((s) => s.tokenHash === session.tokenHash)) {
      throw new Error('Token hash already exists');
    }
    this.sessions.set(session.id, { ...session });
  }

  async getByTokenHash(tokenHash: string): Promise<Session | null> {
    for (const session of this.sessions.values()) {
      if (session.tokenHash === tokenHash) return { ...session };
    }
    return null;
  }

  async getActiveByTokenHash(tokenHash: string, now: string): Promise<Session | null> {
    const session = await this.getByTokenHash(tokenHash);
    if (!session || !isSessionActive(session, now)) return null;
    return session;
  }

  async revoke(tokenHash: string, revokedAt: string): Promise<number> {
    const session = await this.getByTokenHash(tokenHash);
    if (!session || session.revokedAt !== null) return 0;
    this.sessions.set(session.id, { ...session, revokedAt });
    return 1;
  }

  async revokeAllForUser(userId: string, revokedAt: string): Promise<number> {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.userId !== userId || session.revokedAt !== null) continue;
      this.sessions.set(session.id, { ...session, revokedAt });
      count += 1;
    }
    return count;
  }
}

/**
 * In-memory selection store with the same one-active-selection rule as the
 * SQLite and MongoDB adapters: supersede in place, never delete, and leave the
 * historical row's own fields untouched.
 *
 * It calls the same validators as the persistent adapters, so a contract test
 * that rejects a missing `isActive` exercises the rule rather than this fake's
 * own drift.
 */
export class InMemorySelectionRepository implements SelectionRepository {
  private readonly selections: Selection[] = [];

  /** Test helper: drop all rows between cases. */
  clear(): void {
    this.selections.length = 0;
  }

  async select(input: PersistedSelection): Promise<SelectOutcome> {
    assertSelectionRecord(input);
    assertNewSelection(input);

    const active = this.findActive(input.intentId, input.userId);
    if (active && active.snapshotId === input.snapshotId) {
      return { kind: 'ALREADY_ACTIVE', selection: { ...active } };
    }
    if (this.selections.some((selection) => selection.id === input.id)) {
      throw new Error(`Selection ${input.id} already exists`);
    }

    if (active) {
      // Mutate the stored row in place: history keeps its id, selectedAt, price,
      // and snapshot binding, and only the lifecycle fields change.
      active.isActive = false;
      active.supersededAt = input.selectedAt;
    }

    const row: Selection = { ...input, isActive: true, supersededAt: null };
    this.selections.push(row);
    return { kind: 'ACTIVATED', selection: { ...row } };
  }

  async getActive(intentId: string, userId: string): Promise<Selection | null> {
    const active = this.findActive(intentId, userId);
    return active ? { ...active } : null;
  }

  async listHistory(intentId: string, userId: string): Promise<Selection[]> {
    return this.selections
      .filter((selection) => selection.intentId === intentId && selection.userId === userId)
      .sort(
        (a, b) => b.selectedAt.localeCompare(a.selectedAt) || b.id.localeCompare(a.id),
      )
      .map((selection) => ({ ...selection }));
  }

  private findActive(intentId: string, userId: string): Selection | undefined {
    return this.selections.find(
      (selection) =>
        selection.intentId === intentId &&
        selection.userId === userId &&
        selection.isActive,
    );
  }
}
