import type { Product } from '@agentproof/shared';

/**
 * A durable record of the immutable offer snapshot a user selected for one
 * intent (phase P6 schema, populated from P2 onward).
 *
 * Rows are insert-once. The only permitted mutation is the one-way transition
 * from active to superseded, which flips `isActive` and stamps `supersededAt`.
 * A superseded row is never deleted and never rewritten: an approval or an
 * order attempt bound to a `snapshotId` must keep its meaning after the user
 * picks something else.
 *
 * Active state is an explicit boolean, never a null/absent sentinel. That is
 * what lets SQLite (`WHERE is_active = 1`) and MongoDB
 * (`partialFilterExpression: { isActive: true }`) express the identical
 * uniqueness rule, and it is why `isActive` is a required field rather than an
 * optional one with a default.
 */
export interface Selection {
  id: string;
  /** Trusted owner taken from the authenticated session, never from a request body. */
  userId: string;
  intentId: string;
  /** The immutable offer snapshot this selection is bound to. */
  snapshotId: string;
  source: Product['source'];
  productId: string;
  /** Bound at selection time from the snapshot; never from client input. */
  price: number;
  currency: string;
  isActive: boolean;
  selectedAt: string;
  /** ISO timestamp of supersession, or null while this row is the active one. */
  supersededAt: string | null;
}

/** Input to `select()`. Structurally identical to `Selection`; named for intent. */
export type PersistedSelection = Selection;

/**
 * Outcome of a selection attempt.
 *
 *   - `ACTIVATED`       - this call won the slot and the returned row is now the
 *                         single active selection for the intent. Any previous
 *                         active row was superseded, not deleted.
 *   - `ALREADY_ACTIVE`  - the same snapshot was already the active selection, so
 *                         nothing was written and the original row is returned
 *                         unchanged (its `selectedAt` is not refreshed).
 *   - `CONFLICT`        - a competing writer owns the active slot with a
 *                         different snapshot. Nothing was written; the caller
 *                         must surface this rather than silently overwriting
 *                         another selection.
 *
 * A persistence failure is NOT represented here: it surfaces as a rejected
 * Promise so a database error can never be mistaken for a successful or a
 * lost-race outcome.
 */
export type SelectOutcome =
  | { kind: 'ACTIVATED'; selection: Selection }
  | { kind: 'ALREADY_ACTIVE'; selection: Selection }
  | { kind: 'CONFLICT'; selection: Selection };

/**
 * A caller-supplied selection violates the persistence contract. Thrown before
 * any write, on every adapter, so a malformed record can never reach the store.
 */
export class SelectionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SelectionValidationError';
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isoTimestamp(value: unknown): value is string {
  return nonEmptyString(value) && Number.isFinite(Date.parse(value));
}

/**
 * Validate the full active/superseded invariant before any adapter writes.
 *
 * This is deliberately shared by all three adapters (SQLite, MongoDB, in-memory
 * reference) so the rule cannot drift between them, and it is deliberately
 * runtime-only: TypeScript callers can still pass a value built from
 * unvalidated JSON.
 */
export function assertSelectionRecord(input: PersistedSelection): void {
  const record = input as unknown as Record<string, unknown>;

  // `isActive` has no default at the persistence boundary. A missing flag means
  // the caller did not decide the lifecycle state, so it is rejected rather than
  // silently coerced to `true` (which would create a second active row) or
  // `false` (which would create invisible history).
  if (!Object.prototype.hasOwnProperty.call(record, 'isActive')) {
    throw new SelectionValidationError(
      'isActive is required and must be provided explicitly; it is never defaulted',
    );
  }
  if (typeof record.isActive !== 'boolean') {
    throw new SelectionValidationError(
      `isActive must be a boolean, received ${typeof record.isActive}`,
    );
  }

  if (!nonEmptyString(record.id)) {
    throw new SelectionValidationError('id is required');
  }
  if (!nonEmptyString(record.userId)) {
    throw new SelectionValidationError('userId is required');
  }
  if (!nonEmptyString(record.intentId)) {
    throw new SelectionValidationError('intentId is required');
  }
  if (!nonEmptyString(record.snapshotId)) {
    throw new SelectionValidationError('snapshotId is required');
  }
  if (!nonEmptyString(record.source)) {
    throw new SelectionValidationError('source is required');
  }
  if (!nonEmptyString(record.productId)) {
    throw new SelectionValidationError('productId is required');
  }
  if (typeof record.price !== 'number' || !Number.isFinite(record.price) || record.price < 0) {
    throw new SelectionValidationError('price must be a finite, non-negative number');
  }
  if (!nonEmptyString(record.currency)) {
    throw new SelectionValidationError('currency is required');
  }
  if (!isoTimestamp(record.selectedAt)) {
    throw new SelectionValidationError('selectedAt must be an ISO timestamp');
  }

  const { isActive, supersededAt } = record;

  // Active and superseded are two views of the same fact. Keeping the timestamp
  // and the flag consistent here is what makes the SQLite CHECK constraint and
  // the MongoDB partial index agree about which row owns the slot.
  if (isActive === true) {
    if (supersededAt !== null) {
      throw new SelectionValidationError(
        'an active selection must have supersededAt exactly null',
      );
    }
    return;
  }

  if (!isoTimestamp(supersededAt)) {
    throw new SelectionValidationError(
      'a superseded selection must have an ISO supersededAt timestamp',
    );
  }
}

/**
 * `select()` only ever creates the active row. History is produced by
 * supersession, never by inserting an already-inactive row through this path.
 */
export function assertNewSelection(input: PersistedSelection): void {
  if (input.isActive !== true) {
    throw new SelectionValidationError(
      'select() creates an active selection; isActive must be true',
    );
  }
}

/**
 * Server-side store for the user's chosen offer snapshot.
 *
 * There is deliberately no unbounded `getAll()`: selections are always addressed
 * by an intent that the caller must already have proven it owns.
 */
export interface SelectionRepository {
  /**
   * Make one immutable snapshot the active selection for an intent.
   *
   * Implementations must guarantee, by construction rather than by luck, that at
   * most one row per intent is active: supersede (never delete) any existing
   * active row, then insert, and let the partial unique index be the final
   * arbiter. A losing race is reported as `CONFLICT`, never as a silent
   * overwrite of the other writer's row.
   */
  select(selection: PersistedSelection): Promise<SelectOutcome>;

  /** The active selection for an owned intent, or null when none is active. */
  getActive(intentId: string, userId: string): Promise<Selection | null>;

  /**
   * Every selection ever made for an owned intent, newest first. Superseded rows
   * are returned unchanged so history stays auditable.
   */
  listHistory(intentId: string, userId: string): Promise<Selection[]>;
}
