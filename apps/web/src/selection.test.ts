import { describe, expect, it } from 'vitest';
import type { DiscoverCandidate, SelectionView } from './api';
import {
  canStartNewOrder,
  candidateOfferRef,
  candidateSelectionState,
  createIdleSelectionState,
  createInitialSelectionState,
  isSelectionResolved,
  matchOfferCandidate,
  offerKey,
  productOfferRef,
  reduceSelection,
  resolveSelection,
  sameOffer,
  selectionMatchesCandidate,
  selectionOfferRef,
  staleSelectionMessage,
  type OfferRef,
  type SelectionState,
} from './selection';

function candidate(
  productId: string,
  options: {
    source?: 'channel3' | 'demo_catalog';
    snapshotId?: string | null;
    result?: 'ALLOW' | 'DENY';
    fresh?: boolean;
  } = {},
): DiscoverCandidate {
  const source = options.source ?? 'demo_catalog';
  const snapshotId = options.snapshotId === undefined ? `snap-${productId}` : options.snapshotId;
  return {
    snapshotFresh: options.fresh ?? (snapshotId !== null),
    product: {
      id: productId,
      source,
      name: `Product ${productId}`,
      description: 'Test product',
      price: 10,
      currency: 'USD',
      brand: 'Test',
      condition: 'new',
      category: 'Test',
    },
    evaluation: {
      id: `pe-${productId}`,
      intentId: 'intent-1',
      productId,
      result: options.result ?? 'ALLOW',
      confirmationRequired: false,
      ruleResults: [],
      evaluatedAt: '2026-10-20T10:00:00.000Z',
    },
    snapshot:
      snapshotId === null
        ? null
        : {
            id: snapshotId,
            source,
            productId,
            externalProductId: null,
            productName: `Product ${productId}`,
            brand: 'Test',
            merchant: null,
            price: 10,
            currency: 'USD',
            availability: 'InStock',
            condition: 'new',
            compareAtPrice: null,
            maxCommissionRate: null,
            capturedAt: '2026-10-20T10:00:00.000Z',
          },
  };
}

function savedSelection(overrides: Partial<SelectionView> = {}): SelectionView {
  return {
    id: 'sel-1',
    intentId: 'intent-1',
    snapshotId: 'snap-p1',
    source: 'demo_catalog',
    productId: 'p1',
    price: 10,
    currency: 'USD',
    isActive: true,
    selectedAt: '2026-10-20T10:00:00.000Z',
    supersededAt: null,
    ...overrides,
  };
}

function savedState(selection: SelectionView | null, requestId = 1): SelectionState {
  return reduceSelection(createInitialSelectionState(), {
    type: 'readSucceeded',
    requestId,
    selection,
  });
}

describe('offer identity', () => {
  it('uses source plus product id, not a bare product id', () => {
    expect(offerKey({ source: 'demo_catalog', productId: 'p1' })).toBe('demo_catalog:p1');
    expect(
      sameOffer(
        { source: 'demo_catalog', productId: 'p1' },
        { source: 'channel3', productId: 'p1' },
      ),
    ).toBe(false);
    expect(
      sameOffer(
        { source: 'channel3', productId: 'p1' },
        { source: 'channel3', productId: 'p1' },
      ),
    ).toBe(true);
  });

  it('carries a snapshot id only when the candidate has an immutable snapshot', () => {
    expect(candidateOfferRef(candidate('p1')).snapshotId).toBe('snap-p1');
    expect(candidateOfferRef(candidate('p1', { snapshotId: null })).snapshotId).toBeNull();
    expect(productOfferRef(candidate('p1').product).snapshotId).toBeNull();
    expect(selectionOfferRef(savedSelection()).snapshotId).toBe('snap-p1');
  });

  it('requires the exact snapshot when snapshots are available', () => {
    const ref: OfferRef = {
      source: 'demo_catalog',
      productId: 'p1',
      snapshotId: 'snap-old',
    };
    const current = candidate('p1', { snapshotId: 'snap-new' });

    expect(matchOfferCandidate([current], ref)).toEqual({ kind: 'snapshot_mismatch' });
    expect(matchOfferCandidate([], ref)).toEqual({ kind: 'missing' });
    expect(
      matchOfferCandidate([candidate('p1', { snapshotId: 'snap-old' })], ref).kind,
    ).toBe('matched');
    // A legacy candidate with no snapshot cannot substitute for an exact
    // snapshot-bound selection.
    expect(matchOfferCandidate([candidate('p1', { snapshotId: null })], ref).kind).toBe(
      'snapshot_missing',
    );
  });

  it('accepts only a selection response for the exact clicked snapshot', () => {
    const clicked = candidate('p1');

    expect(selectionMatchesCandidate(savedSelection(), clicked)).toBe(true);
    expect(
      selectionMatchesCandidate(savedSelection({ snapshotId: 'snap-other' }), clicked),
    ).toBe(false);
    expect(
      selectionMatchesCandidate(savedSelection({ productId: 'p2' }), clicked),
    ).toBe(false);
    expect(
      selectionMatchesCandidate(savedSelection({ source: 'channel3' }), clicked),
    ).toBe(false);
    expect(selectionMatchesCandidate(savedSelection({ price: 9.99 }), clicked)).toBe(false);
    expect(selectionMatchesCandidate(savedSelection({ currency: 'EUR' }), clicked)).toBe(false);
    expect(selectionMatchesCandidate(savedSelection({ isActive: false }), clicked)).toBe(false);
    expect(
      selectionMatchesCandidate(savedSelection(), candidate('p1', { fresh: false })),
    ).toBe(false);
    expect(
      selectionMatchesCandidate(savedSelection(), candidate('p1', { snapshotId: null })),
    ).toBe(false);
  });
});

describe('selection provenance', () => {
  it('shows a recommendation or fallback without treating it as persisted', () => {
    const allowed = candidate('p1');
    const state = createIdleSelectionState();

    const recommended = resolveSelection({
      candidates: [allowed],
      state,
      recommendation: candidateOfferRef(allowed),
    });
    const fallback = resolveSelection({
      candidates: [allowed],
      state,
      fallback: candidateOfferRef(allowed),
    });

    expect(recommended.origin).toBe('recommendation');
    expect(recommended.candidate?.product.id).toBe('p1');
    expect(fallback.origin).toBe('fallback');
    expect(fallback.candidate?.product.id).toBe('p1');
    expect(resolveSelection({ candidates: [allowed], state }).origin).toBe('none');
    expect(state.saved).toBeNull();
  });

  it('prefers a persisted selection over a recommendation', () => {
    const allowed = candidate('p1');
    const resolution = resolveSelection({
      candidates: [allowed],
      state: savedState(savedSelection()),
      recommendation: candidateOfferRef(allowed),
    });

    expect(resolution.origin).toBe('persisted');
    expect(resolution.candidate?.product.id).toBe('p1');
    expect(resolution.staleReason).toBeNull();
    expect(candidateSelectionState(allowed, resolution)).toBe('persisted');
  });

  it('does not promote a recommendation when it cannot be matched', () => {
    const resolution = resolveSelection({
      candidates: [candidate('p2')],
      state: createIdleSelectionState(),
      recommendation: { source: 'demo_catalog', productId: 'p1', snapshotId: null },
      fallback: candidateOfferRef(candidate('p2')),
    });

    expect(resolution.origin).toBe('recommendation');
    expect(resolution.candidate).toBeNull();
    expect(candidateSelectionState(candidate('p2'), resolution)).toBe('none');
  });

  it('reports a missing saved offer instead of selecting another one', () => {
    const other = candidate('p2');
    const resolution = resolveSelection({
      candidates: [other],
      state: savedState(savedSelection()),
    });

    expect(resolution.origin).toBe('persisted');
    expect(resolution.staleReason).toBe('OFFER_MISSING');
    expect(resolution.candidate).toBeNull();
    expect(candidateSelectionState(other, resolution)).toBe('none');
  });

  it('reports a re-captured snapshot without highlighting the new capture', () => {
    const recaptured = candidate('p1', { snapshotId: 'snap-new' });
    const resolution = resolveSelection({
      candidates: [recaptured],
      state: savedState(savedSelection()),
    });

    expect(resolution.staleReason).toBe('SNAPSHOT_CHANGED');
    expect(resolution.candidate).toBeNull();
    expect(candidateSelectionState(recaptured, resolution)).toBe('none');
  });

  it('reports a saved offer that policy no longer authorizes', () => {
    const denied = candidate('p1', { result: 'DENY' });
    const resolution = resolveSelection({
      candidates: [denied],
      state: savedState(savedSelection()),
    });

    expect(resolution.staleReason).toBe('NOT_AUTHORIZED');
    expect(resolution.candidate).toBeNull();
    expect(candidateSelectionState(denied, resolution)).toBe('none');
  });

  it('reports a stale saved snapshot and never enables a new order', () => {
    const stale = candidate('p1', { fresh: false });
    const state = savedState(savedSelection());
    const resolution = resolveSelection({ candidates: [stale], state });

    expect(resolution.staleReason).toBe('SNAPSHOT_STALE');
    expect(resolution.candidate).toBeNull();
    expect(candidateSelectionState(stale, resolution)).toBe('none');
    expect(canStartNewOrder(resolution, state)).toBe(false);
  });

  it('does not display a stale recommendation or fallback as selectable', () => {
    const stale = candidate('p1', { fresh: false });
    const state = createIdleSelectionState();
    const recommended = resolveSelection({
      candidates: [stale],
      state,
      recommendation: candidateOfferRef(stale),
    });
    const fallback = resolveSelection({
      candidates: [stale],
      state,
      fallback: candidateOfferRef(stale),
    });

    expect(recommended.origin).toBe('recommendation');
    expect(recommended.candidate).toBeNull();
    expect(fallback.origin).toBe('fallback');
    expect(fallback.candidate).toBeNull();
  });

  it('fails closed when a saved selection has no immutable snapshot', () => {
    const legacy = candidate('p1', { snapshotId: null });
    const resolution = resolveSelection({
      candidates: [legacy],
      state: savedState(savedSelection()),
    });
    const missingId = resolveSelection({
      candidates: [candidate('p1')],
      state: savedState(savedSelection({ snapshotId: '' })),
    });

    expect(resolution.staleReason).toBe('SNAPSHOT_MISSING');
    expect(resolution.candidate).toBeNull();
    expect(candidateSelectionState(legacy, resolution)).toBe('none');
    expect(canStartNewOrder(resolution, savedState(savedSelection()))).toBe(false);
    expect(missingId.staleReason).toBe('SNAPSHOT_MISSING');
    expect(missingId.candidate).toBeNull();
  });

  it('fails closed for a recommendation, fallback, or pending choice', () => {
    const allowed = candidate('p1');
    const saved = savedSelection();
    const recommendation = resolveSelection({
      candidates: [allowed],
      state: createIdleSelectionState(),
      recommendation: candidateOfferRef(allowed),
    });
    const pending = reduceSelection(savedState(saved), {
      type: 'saveStarted',
      requestId: 2,
      ref: candidateOfferRef(allowed),
    });
    const pendingResolution = resolveSelection({ candidates: [allowed], state: pending });

    expect(canStartNewOrder(recommendation, createIdleSelectionState())).toBe(false);
    expect(canStartNewOrder(pendingResolution, pending)).toBe(false);
    expect(
      canStartNewOrder(
        resolveSelection({ candidates: [allowed], state: savedState(saved) }),
        savedState(saved),
      ),
    ).toBe(true);
  });

  it('shows an in-flight explicit choice as pending, not as saved', () => {
    const first = candidate('p1');
    const second = candidate('p2', { snapshotId: 'snap-p2' });
    const state = reduceSelection(savedState(savedSelection()), {
      type: 'saveStarted',
      requestId: 2,
      ref: candidateOfferRef(second),
    });
    const resolution = resolveSelection({ candidates: [first, second], state });

    expect(resolution.origin).toBe('pending');
    expect(resolution.candidate?.product.id).toBe('p2');
    expect(candidateSelectionState(second, resolution)).toBe('pending');
    expect(candidateSelectionState(first, resolution)).toBe('none');
  });

  it('labels a failed newer save without presenting the older row as current', () => {
    const first = candidate('p1');
    const second = candidate('p2');
    const failed = reduceSelection(
      reduceSelection(savedState(savedSelection()), {
        type: 'saveStarted',
        requestId: 2,
        ref: candidateOfferRef(second),
      }),
      { type: 'saveFailed', requestId: 2, message: 'Selection conflict' },
    );
    const resolution = resolveSelection({ candidates: [first, second], state: failed });

    expect(failed.failedRef?.productId).toBe('p2');
    expect(candidateSelectionState(first, resolution)).toBe('previously_saved');
    expect(candidateSelectionState(second, resolution)).toBe('save_failed');
    expect(canStartNewOrder(resolution, failed)).toBe(false);
  });

  it('does not call a recommendation previously saved after an unrelated failed save', () => {
    const recommended = candidate('p1');
    const failedChoice = candidate('p2');
    const failed = reduceSelection(
      reduceSelection(createIdleSelectionState(), {
        type: 'saveStarted',
        requestId: 1,
        ref: candidateOfferRef(failedChoice),
      }),
      { type: 'saveFailed', requestId: 1, message: 'Selection conflict' },
    );
    const resolution = resolveSelection({
      candidates: [recommended, failedChoice],
      state: failed,
      recommendation: candidateOfferRef(recommended),
    });

    expect(candidateSelectionState(recommended, resolution)).toBe('recommendation');
    expect(candidateSelectionState(failedChoice, resolution)).toBe('save_failed');
    expect(canStartNewOrder(resolution, failed)).toBe(false);
  });

  it('explains every stale reason without offering a substitute', () => {
    for (const reason of [
      'OFFER_MISSING',
      'SNAPSHOT_CHANGED',
      'SNAPSHOT_MISSING',
      'SNAPSHOT_STALE',
      'NOT_AUTHORIZED',
    ] as const) {
      const message = staleSelectionMessage(reason);
      expect(message).toMatch(/select/i);
    }
  });
});

describe('selection state machine', () => {
  it('treats a null read as resolved-empty and a selection as saved', () => {
    const empty = savedState(null);
    const saved = savedState(savedSelection());

    expect(empty.status).toBe('idle');
    expect(empty.saved).toBeNull();
    expect(isSelectionResolved(empty)).toBe(true);
    expect(saved.status).toBe('saved');
    expect(saved.saved?.id).toBe('sel-1');
    expect(isSelectionResolved(saved)).toBe(true);
  });

  it('keeps an in-flight save unresolved', () => {
    const pending = reduceSelection(savedState(savedSelection()), {
      type: 'saveStarted',
      requestId: 2,
      ref: candidateOfferRef(candidate('p2')),
    });

    expect(pending.status).toBe('pending');
    expect(pending.pending?.productId).toBe('p2');
    expect(pending.saved?.id).toBe('sel-1');
    expect(isSelectionResolved(pending)).toBe(false);
  });

  it('ignores an older read that arrives after a newer save started', () => {
    const pending = reduceSelection(savedState(savedSelection()), {
      type: 'saveStarted',
      requestId: 2,
      ref: candidateOfferRef(candidate('p2')),
    });
    const lateRead = reduceSelection(pending, {
      type: 'readSucceeded',
      requestId: 1,
      selection: null,
    });

    expect(lateRead).toBe(pending);
  });

  it('ignores an older read that arrives after a newer save was confirmed', () => {
    const pending = reduceSelection(savedState(savedSelection()), {
      type: 'saveStarted',
      requestId: 2,
      ref: candidateOfferRef(candidate('p2')),
    });
    const confirmed = reduceSelection(pending, {
      type: 'saveSucceeded',
      requestId: 2,
      selection: savedSelection({ id: 'sel-2', productId: 'p2', snapshotId: 'snap-p2' }),
    });
    const lateRead = reduceSelection(confirmed, {
      type: 'readSucceeded',
      requestId: 1,
      selection: savedSelection(),
    });

    expect(lateRead).toBe(confirmed);
    expect(lateRead.saved?.id).toBe('sel-2');
  });

  it('ignores an older save response that arrives after a newer read started', () => {
    const reading = reduceSelection(savedState(savedSelection()), {
      type: 'readStarted',
      requestId: 3,
    });
    const lateSave = reduceSelection(reading, {
      type: 'saveSucceeded',
      requestId: 2,
      selection: savedSelection({ id: 'sel-old' }),
    });

    expect(lateSave).toBe(reading);
    expect(lateSave.status).toBe('unresolved');
  });

  it('retains the last confirmed selection after a failed save but stays unresolved', () => {
    const failed = reduceSelection(
      reduceSelection(savedState(savedSelection()), {
        type: 'saveStarted',
        requestId: 2,
        ref: candidateOfferRef(candidate('p2')),
      }),
      { type: 'saveFailed', requestId: 2, message: 'Selection conflict' },
    );

    expect(failed.status).toBe('error');
    expect(failed.pending).toBeNull();
    expect(failed.failedRef?.productId).toBe('p2');
    expect(failed.error).toBe('Selection conflict');
    expect(failed.saved?.id).toBe('sel-1');
    expect(isSelectionResolved(failed)).toBe(false);
  });

  it('marks a failed read unresolved and never saved', () => {
    const failed = reduceSelection(createInitialSelectionState(), {
      type: 'readFailed',
      requestId: 1,
      message: 'Failed to load your saved selection',
    });

    expect(failed.status).toBe('error');
    expect(failed.saved).toBeNull();
    expect(isSelectionResolved(failed)).toBe(false);
  });

  it('resets to an explicit idle or unresolved state', () => {
    const idle = reduceSelection(savedState(savedSelection()), {
      type: 'reset',
      status: 'idle',
    });
    const unresolved = reduceSelection(savedState(savedSelection()), {
      type: 'reset',
      status: 'unresolved',
    });

    expect(idle.status).toBe('idle');
    expect(idle.saved).toBeNull();
    expect(unresolved.status).toBe('unresolved');
  });
});
