import type { Product } from '@agentproof/shared';
import type { DiscoverCandidate, SelectionView } from './api';

/**
 * Identity of one offer inside a discovery result.
 *
 * `source` plus `productId` is the stable identity the rest of the workflow
 * already uses. `snapshotId` is added when an immutable snapshot exists so a
 * persisted selection can never be matched to a later capture of the "same"
 * product with a different price.
 */
export interface OfferRef {
  source: Product['source'];
  productId: string;
  snapshotId: string | null;
}

/** Where the offer currently shown in the UI came from. */
export type SelectionOrigin =
  | 'none'
  | 'recommendation'
  | 'fallback'
  | 'pending'
  | 'persisted';

/** What a single candidate card should say about this offer. */
export type CandidateSelectionState =
  | SelectionOrigin
  /** A prior confirmed selection that is no longer a valid current choice. */
  | 'previously_saved'
  /** The offer whose most recent save attempt failed. */
  | 'save_failed';

export type SelectionStatus = 'unresolved' | 'idle' | 'pending' | 'saved' | 'error';

/**
 * Audit-evidence status for the last server-confirmed selection.
 *
 * A selection can persist while its PRODUCT_SELECTED evidence write fails. The
 * selection remains valid and keeps its snapshot binding, but the workflow must
 * not claim the audit event was recorded.
 */
export interface SelectionEvidenceStatus {
  recorded: boolean;
  error: string | null;
}

/**
 * Client-side provenance for the selection UI.
 *
 * `saved` is only ever a response from the selection API. A recommendation, a
 * fallback, or an in-flight explicit choice is never written here, so the UI
 * cannot describe one of those as a persisted user choice.
 */
export interface SelectionState {
  /** Monotonic id of the newest request allowed to affect the UI. */
  requestId: number;
  status: SelectionStatus;
  /** The last server-confirmed selection, or null when none is known. */
  saved: SelectionView | null;
  /** Evidence status for `saved`; null when the API did not report it. */
  savedEvidence?: SelectionEvidenceStatus | null;
  /** An explicit choice whose persistence request is still in flight. */
  pending: OfferRef | null;
  /** The offer whose most recent save attempt failed, when known. */
  failedRef: OfferRef | null;
  error: string | null;
}

export type SelectionStaleReason =
  | 'OFFER_MISSING'
  | 'SNAPSHOT_CHANGED'
  | 'SNAPSHOT_MISSING'
  | 'SNAPSHOT_STALE'
  | 'NOT_AUTHORIZED';

export interface SelectionResolution {
  origin: SelectionOrigin;
  /** The candidate that may be shown as the current offer, or null. */
  candidate: DiscoverCandidate | null;
  ref: OfferRef | null;
  /** Set only when a persisted selection cannot be safely matched. */
  staleReason: SelectionStaleReason | null;
  /** The offer whose most recent save attempt failed, when known. */
  failedRef: OfferRef | null;
}

export function createInitialSelectionState(): SelectionState {
  return {
    requestId: 0,
    status: 'unresolved',
    saved: null,
    savedEvidence: null,
    pending: null,
    failedRef: null,
    error: null,
  };
}

/** A workflow that is known to have no persisted selection yet. */
export function createIdleSelectionState(): SelectionState {
  return {
    requestId: 0,
    status: 'idle',
    saved: null,
    savedEvidence: null,
    pending: null,
    failedRef: null,
    error: null,
  };
}

export function offerKey(ref: Pick<OfferRef, 'source' | 'productId'>): string {
  return `${ref.source}:${ref.productId}`;
}

/** Stable offer identity. Snapshots are compared separately. */
export function sameOffer(
  left: Pick<OfferRef, 'source' | 'productId'> | null,
  right: Pick<OfferRef, 'source' | 'productId'> | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.source === right.source &&
    left.productId === right.productId
  );
}

export function candidateOfferRef(candidate: DiscoverCandidate): OfferRef {
  return {
    source: candidate.product.source,
    productId: candidate.product.id,
    snapshotId: candidate.snapshot?.id ?? null,
  };
}

/** A product record carries no snapshot identity of its own. */
export function productOfferRef(product: Product): OfferRef {
  return {
    source: product.source,
    productId: product.id,
    snapshotId: null,
  };
}

export function selectionOfferRef(selection: SelectionView): OfferRef {
  return {
    source: selection.source,
    productId: selection.productId,
    snapshotId: selection.snapshotId,
  };
}

/**
 * Verify that a server-confirmed selection is exactly the offer the user
 * clicked. The response must carry the same immutable snapshot, intent, source,
 * product, and snapshot-bound price/currency; anything else is a failed save,
 * not a reason to adopt the server's choice.
 */
export function selectionMatchesCandidate(
  selection: SelectionView,
  candidate: DiscoverCandidate,
): boolean {
  const snapshot = candidate.snapshot;
  return (
    candidate.snapshotFresh === true &&
    snapshot != null &&
    selection.isActive &&
    selection.intentId === candidate.evaluation.intentId &&
    selection.snapshotId === snapshot.id &&
    snapshot.source === selection.source &&
    snapshot.productId === selection.productId &&
    selection.source === candidate.product.source &&
    selection.productId === candidate.product.id &&
    selection.price === snapshot.price &&
    selection.currency === snapshot.currency
  );
}

/** A candidate may be current only when policy allows it and its snapshot is fresh. */
function isCurrentCandidate(candidate: DiscoverCandidate): boolean {
  return candidate.evaluation.result === 'ALLOW' && candidate.snapshotFresh === true;
}

export type CandidateMatch =
  | { kind: 'matched'; candidate: DiscoverCandidate }
  | { kind: 'missing' }
  | { kind: 'snapshot_mismatch' }
  | { kind: 'snapshot_missing' };

/**
 * Resolve an offer against the candidates currently on screen.
 *
 * Source plus product id is the base identity. When the caller knows a snapshot
 * id, only the exact snapshot may match: re-discovery may reuse a product id for
 * a different price, and silently treating that as the same choice would rewrite
 * what the user approved.
 *
 * A candidate without a snapshot cannot stand in for a snapshot-bound offer. It
 * is reported as `snapshot_missing` so callers can fail closed rather than
 * silently falling back to mutable product data.
 */
export function matchOfferCandidate(
  candidates: readonly DiscoverCandidate[],
  ref: OfferRef,
): CandidateMatch {
  const matches = candidates.filter(
    (candidate) =>
      candidate.product.source === ref.source && candidate.product.id === ref.productId,
  );
  if (matches.length === 0) return { kind: 'missing' };
  if (!ref.snapshotId) return { kind: 'matched', candidate: matches[0] };

  const exact = matches.find((candidate) => candidate.snapshot?.id === ref.snapshotId);
  if (exact) return { kind: 'matched', candidate: exact };

  return matches.some((candidate) => candidate.snapshot != null)
    ? { kind: 'snapshot_mismatch' }
    : { kind: 'snapshot_missing' };
}

export interface ResolveSelectionInput {
  candidates: readonly DiscoverCandidate[];
  state: SelectionState;
  /** Server recommendation (`discover.selectedProduct`), never persisted here. */
  recommendation?: OfferRef | null;
  /** First authorized option when discovery made no recommendation. */
  fallback?: OfferRef | null;
}

/**
 * Decide which offer the UI may present and with which provenance.
 *
 * Precedence is deliberate:
 *   1. an explicit choice still being saved (shown as pending, never saved);
 *   2. the last server-confirmed selection (even when it is stale, so a failed
 *      match is reported instead of silently falling back to another offer);
 *   3. the AI recommendation;
 *   4. the automatic fallback.
 *
 * Recommendations and fallbacks are display-only. They are never returned as
 * `persisted`, and a stale persisted selection never degrades into either of
 * them: the user has to choose again.
 */
export function resolveSelection(input: ResolveSelectionInput): SelectionResolution {
  const { candidates, state, recommendation = null, fallback = null } = input;
  const failedRef = state.failedRef;

  if (state.pending) {
    const match = matchOfferCandidate(candidates, state.pending);
    return {
      origin: 'pending',
      candidate:
        match.kind === 'matched' && isCurrentCandidate(match.candidate)
          ? match.candidate
          : null,
      ref: state.pending,
      staleReason: null,
      failedRef,
    };
  }

  if (state.saved) {
    const ref = selectionOfferRef(state.saved);
    if (!ref.snapshotId) {
      return {
        origin: 'persisted',
        candidate: null,
        ref,
        staleReason: 'SNAPSHOT_MISSING',
        failedRef,
      };
    }
    const match = matchOfferCandidate(candidates, ref);
    if (match.kind === 'missing') {
      return {
        origin: 'persisted',
        candidate: null,
        ref,
        staleReason: 'OFFER_MISSING',
        failedRef,
      };
    }
    if (match.kind === 'snapshot_mismatch') {
      return {
        origin: 'persisted',
        candidate: null,
        ref,
        staleReason: 'SNAPSHOT_CHANGED',
        failedRef,
      };
    }
    if (match.kind === 'snapshot_missing') {
      return {
        origin: 'persisted',
        candidate: null,
        ref,
        staleReason: 'SNAPSHOT_MISSING',
        failedRef,
      };
    }
    if (match.candidate.evaluation.result !== 'ALLOW') {
      return {
        origin: 'persisted',
        candidate: null,
        ref,
        staleReason: 'NOT_AUTHORIZED',
        failedRef,
      };
    }
    if (match.candidate.snapshotFresh !== true) {
      return {
        origin: 'persisted',
        candidate: null,
        ref,
        staleReason: 'SNAPSHOT_STALE',
        failedRef,
      };
    }
    return {
      origin: 'persisted',
      candidate: match.candidate,
      ref,
      staleReason: null,
      failedRef,
    };
  }

  // If a recommendation exists but no longer matches, report no offer rather
  // than quietly promoting the fallback or another candidate.
  if (recommendation) {
    const match = matchOfferCandidate(candidates, recommendation);
    return {
      origin: 'recommendation',
      candidate:
        match.kind === 'matched' && isCurrentCandidate(match.candidate)
          ? match.candidate
          : null,
      ref: recommendation,
      staleReason: null,
      failedRef,
    };
  }

  if (fallback) {
    const match = matchOfferCandidate(candidates, fallback);
    return {
      origin: 'fallback',
      candidate:
        match.kind === 'matched' && isCurrentCandidate(match.candidate)
          ? match.candidate
          : null,
      ref: fallback,
      staleReason: null,
      failedRef,
    };
  }

  return { origin: 'none', candidate: null, ref: null, staleReason: null, failedRef };
}

/**
 * New-order creation is allowed only for a resolved, persisted selection whose
 * exact immutable snapshot is still present and matches the stored selection.
 *
 * This is intentionally stricter than "a candidate is visible": recommendations,
 * fallbacks, legacy snapshot-less rows, failed reads, and failed saves all fail
 * closed.
 */
export function canStartNewOrder(
  resolution: SelectionResolution,
  state: SelectionState,
): boolean {
  const saved = state.saved;
  const snapshot = resolution.candidate?.snapshot;
  return (
    isSelectionResolved(state) &&
    saved !== null &&
    resolution.origin === 'persisted' &&
    resolution.staleReason === null &&
    resolution.candidate !== null &&
    resolution.candidate.snapshotFresh === true &&
    snapshot != null &&
    snapshot.id === saved.snapshotId &&
    resolution.candidate.product.source === saved.source &&
    resolution.candidate.product.id === saved.productId
  );
}

function sameCandidate(left: DiscoverCandidate, right: DiscoverCandidate): boolean {
  const leftRef = candidateOfferRef(left);
  const rightRef = candidateOfferRef(right);
  return sameOffer(leftRef, rightRef) && leftRef.snapshotId === rightRef.snapshotId;
}

/**
 * Provenance for one card. Snapshot mismatches deliberately do not highlight
 * the newly captured offer as if it were the saved choice.
 */
export function candidateSelectionState(
  candidate: DiscoverCandidate,
  resolution: SelectionResolution,
): CandidateSelectionState {
  const failed = resolution.failedRef;
  if (failed) {
    const failedCandidate = matchOfferCandidate([candidate], failed);
    if (failedCandidate.kind === 'matched') return 'save_failed';
  }

  if (resolution.origin === 'none' || !resolution.candidate) return 'none';
  if (!sameCandidate(candidate, resolution.candidate)) return 'none';

  // A failed newer save must not present the older confirmed row as the
  // current saved choice. The card can still be selected again. Only a
  // server-confirmed persisted row can be described as "previously saved".
  return failed && resolution.origin === 'persisted' ? 'previously_saved' : resolution.origin;
}

export function staleSelectionMessage(reason: SelectionStaleReason): string {
  switch (reason) {
    case 'OFFER_MISSING':
      return 'Your saved selection is no longer part of the current discovery results. Re-run discovery or select an offer again.';
    case 'SNAPSHOT_CHANGED':
      return 'The offer you selected was re-captured by a later discovery. Select it again to record the current offer.';
    case 'SNAPSHOT_MISSING':
      return 'Your saved selection has no immutable offer snapshot in the current results. Re-run discovery and select the offer again.';
    case 'SNAPSHOT_STALE':
      return 'The offer you selected is older than AgentProof\'s freshness window. Re-run discovery and select the current offer again.';
    case 'NOT_AUTHORIZED':
      return 'The offer you selected is no longer authorized by policy. Select a currently authorized offer.';
  }
}

export type SelectionAction =
  | { type: 'readStarted'; requestId: number }
  | { type: 'readSucceeded'; requestId: number; selection: SelectionView | null }
  | { type: 'readFailed'; requestId: number; message: string }
  | { type: 'saveStarted'; requestId: number; ref: OfferRef }
  | { type: 'saveSucceeded'; requestId: number; selection: SelectionView; evidenceRecorded?: boolean; evidenceError?: string | null }
  | { type: 'saveFailed'; requestId: number; message: string }
  | { type: 'reset'; requestId?: number; status?: 'unresolved' | 'idle' };

/**
 * Pure state machine for selection reads and writes.
 *
 * Any response older than the newest started request is discarded, so a slow
 * restore can never overwrite a newer explicit choice. A failed save keeps the
 * last confirmed selection for display but leaves the state unresolved, which
 * disables new-order actions until the user retries or reloads.
 */
export function reduceSelection(
  state: SelectionState,
  action: SelectionAction,
): SelectionState {
  if (action.type === 'reset') {
    const next =
      action.status === 'idle' ? createIdleSelectionState() : createInitialSelectionState();
    return { ...next, requestId: action.requestId ?? state.requestId };
  }

  if (action.requestId < state.requestId) return state;

  switch (action.type) {
    case 'readStarted':
      return {
        requestId: action.requestId,
        status: 'unresolved',
        saved: null,
        savedEvidence: null,
        pending: null,
        failedRef: null,
        error: null,
      };
    case 'readSucceeded':
      return {
        requestId: action.requestId,
        status: action.selection ? 'saved' : 'idle',
        saved: action.selection,
        savedEvidence: null,
        pending: null,
        failedRef: null,
        error: null,
      };
    case 'readFailed':
      return {
        requestId: action.requestId,
        status: 'error',
        saved: null,
        savedEvidence: null,
        pending: null,
        failedRef: null,
        error: action.message,
      };
    case 'saveStarted':
      return {
        ...state,
        requestId: action.requestId,
        status: 'pending',
        pending: action.ref,
        failedRef: null,
        error: null,
      };
    case 'saveSucceeded':
      return {
        requestId: action.requestId,
        status: 'saved',
        saved: action.selection,
        savedEvidence: action.evidenceRecorded !== undefined
          ? { recorded: action.evidenceRecorded, error: action.evidenceError ?? null }
          : null,
        pending: null,
        failedRef: null,
        error: null,
      };
    case 'saveFailed':
      return {
        ...state,
        requestId: action.requestId,
        status: 'error',
        pending: null,
        failedRef: state.pending,
        error: action.message,
      };
  }
}

/**
 * True only when the client has a trustworthy answer: a confirmed selection or
 * a confirmed absence of one. Loading, an in-flight save, and failures are all
 * unresolved.
 */
export function isSelectionResolved(state: SelectionState): boolean {
  return state.status === 'saved' || state.status === 'idle';
}

/** Human‑readable warning when a saved selection has incomplete evidence. */
export function selectionEvidenceWarning(state: SelectionState): string | null {
  if (
    state.status !== 'saved' ||
    state.saved === null ||
    state.savedEvidence === null ||
    state.savedEvidence.recorded !== false
  ) {
    return null;
  }
  return 'Selection saved, but audit evidence could not be recorded.';
}
