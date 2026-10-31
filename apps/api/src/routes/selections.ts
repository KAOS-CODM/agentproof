import { Router } from 'express';
import { z } from 'zod';
import {
  getEvidenceService,
  getIntentRepository,
  getProductRepository,
  getSelectionRepository,
} from '../models/repositories.js';
import type { Selection } from '../services/selection/SelectionRepository.js';
import { isOfferSnapshotFresh } from '../services/discovery/OfferSnapshot.js';
import { DEFAULT_PRODUCT_MAX_AGE_MS } from '../services/discovery/ProductResolutionService.js';
import { generateId } from '../utils/id.js';
import { logger } from '../utils/logger.js';
import { requireAuth } from '../middleware/auth.js';

export const selectionsRouter = Router();
selectionsRouter.use(requireAuth);

/**
 * Browser-safe projection of a stored selection.
 *
 * `userId` is deliberately absent: the caller has already proven that it owns
 * the intent, and echoing an internal owner id adds nothing. Price and currency
 * are the values bound from the immutable snapshot when the selection was made,
 * not the current shared offer, so a later refresh cannot rewrite what the user
 * chose.
 */
interface SelectionView {
  id: string;
  intentId: string;
  snapshotId: string;
  source: string;
  productId: string;
  price: number;
  currency: string;
  isActive: boolean;
  selectedAt: string;
  supersededAt: string | null;
}

function toView(selection: Selection): SelectionView {
  return {
    id: selection.id,
    intentId: selection.intentId,
    snapshotId: selection.snapshotId,
    source: selection.source,
    productId: selection.productId,
    price: selection.price,
    currency: selection.currency,
    isActive: selection.isActive,
    selectedAt: selection.selectedAt,
    supersededAt: selection.supersededAt,
  };
}

/**
 * The client names the exact offer snapshot it displayed. The snapshot id is
 * expected identity, never price/currency input: the server resolves that exact
 * owner-scoped row and binds its stored values. A tampered body cannot change
 * what is about to be approved or purchased, and re-discovery cannot silently
 * redirect the write to a newer snapshot.
 */
const selectionCreateSchema = z.object({
  intentId: z.string().min(1),
  source: z.enum(['channel3', 'demo_catalog']),
  productId: z.string().min(1),
  snapshotId: z.string().min(1),
});

/**
 * Select one immutable offer snapshot for an owned intent.
 *
 * Status codes carry the outcome, never a bare 200:
 *   201 - this request activated the selection
 *   200 - the same snapshot was already active; no new selection row was written
 *   409 - a competing selection owns the slot (SELECTION_CONFLICT), the
 *         snapshot is unavailable (NO_SNAPSHOT), or the snapshot identity does
 *         not match the requested intent/source/product (SNAPSHOT_MISMATCH)
 *   410 - the exact snapshot is older than the freshness window
 *         (STALE_SNAPSHOT)
 *   404 - unknown intent, or another user's intent (no existence leak)
 *
 * A confirmed selection (201/200) also records PRODUCT_SELECTED evidence bound
 * to the persisted row. If that evidence write fails, the selection itself is
 * still persisted: the status stays 201/200 and the body adds
 * `evidenceRecorded: false` and `evidenceError: 'EVIDENCE_PERSISTENCE_FAILED'`.
 * Retrying the same snapshot repairs the missing event only while the
 * corresponding selection remains active: the deterministic evidence ID is
 * derived from that selection's ID. After supersession, a retry creates a new
 * selection ID and evidence ID; it does not repair the historical selection's
 * missing event.
 */
selectionsRouter.post('/', async (req, res) => {
  const parsed = selectionCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }

  const { intentId } = parsed.data;

  try {
    const userId = req.auth!.user.id;
    const { source, productId, snapshotId } = parsed.data;

    const intent = await getIntentRepository().getByIdForUser(intentId, userId);
    if (!intent) {
      // Same 404 for unknown and another user's intent: no existence leak.
      res.status(404).json({ error: 'Intent not found' });
      return;
    }

    // Resolve the exact snapshot the client displayed. This deliberately does
    // not go through the mutable discovery association: re-discovery may replace
    // that association with a newer snapshot, and this write must never silently
    // bind the newer offer. Ownership is enforced inside the repository, so a
    // missing snapshot and a snapshot owned by another user both return null.
    const snapshot = await getProductRepository().getSnapshotById(snapshotId, userId);
    if (!snapshot || snapshot.userId !== userId) {
      res.status(409).json({
        error: 'The selected offer snapshot is unavailable; re-run discovery.',
        code: 'NO_SNAPSHOT',
      });
      return;
    }

    // Defensive identity checks: the resolved snapshot must be exactly the one
    // named by the client and must agree with the requested intent/source/product.
    // A different snapshot is never substituted.
    if (
      snapshot.id !== snapshotId ||
      snapshot.intentId !== intentId ||
      snapshot.source !== source ||
      snapshot.productId !== productId
    ) {
      res.status(409).json({
        error: 'The offer snapshot does not match the selected intent, source, and product.',
        code: 'SNAPSHOT_MISMATCH',
      });
      return;
    }

    // Use the project's existing freshness window. A stale snapshot cannot become
    // a current selection, even if its immutable row still exists.
    if (
      !isOfferSnapshotFresh(
        snapshot.capturedAt,
        Date.now(),
        DEFAULT_PRODUCT_MAX_AGE_MS,
      )
    ) {
      res.status(410).json({
        error: 'This offer snapshot is older than the freshness window; re-run discovery.',
        code: 'STALE_SNAPSHOT',
      });
      return;
    }

    const outcome = await getSelectionRepository().select({
      id: generateId(),
      userId,
      intentId,
      snapshotId: snapshot.id,
      source: snapshot.source,
      productId: snapshot.productId,
      price: snapshot.price,
      currency: snapshot.currency,
      isActive: true,
      selectedAt: new Date().toISOString(),
      supersededAt: null,
    });

    if (outcome.kind === 'CONFLICT') {
      logger.warn('Selection conflict', { intentId });
      res.status(409).json({
        error: 'Another selection for this intent was activated concurrently; reload and try again.',
        code: 'SELECTION_CONFLICT',
        selection: toView(outcome.selection),
      });
      return;
    }

    logger.info('Selection recorded', {
      intentId,
      snapshotId: snapshot.id,
      outcome: outcome.kind,
    });

    // Record PRODUCT_SELECTED evidence for a confirmed selection (ACTIVATED or
    // ALREADY_ACTIVE). Financial facts come from the immutable snapshot, never
    // from client input. The deterministic evidence ID makes a repeated selection
    // of the same snapshot idempotent: it never creates a duplicate event.
    let evidenceRecorded = true;
    let evidenceError: string | null = null;
    try {
      const evidenceService = getEvidenceService();
      await evidenceService.recordIdempotent(
        {
          id: `sel:${outcome.selection.id}:PRODUCT_SELECTED`,
          eventType: 'PRODUCT_SELECTED',
          actor: 'user',
          source: 'user_input',
          intentId: outcome.selection.intentId,
          data: {
            selectionId: outcome.selection.id,
            snapshotId: outcome.selection.snapshotId,
            source: outcome.selection.source,
            productId: outcome.selection.productId,
            price: outcome.selection.price,
            currency: outcome.selection.currency,
          },
        },
        userId,
      );
    } catch (err) {
      // Selection persisted successfully; only evidence failed. Report partial
      // success rather than claiming the selection failed or was rolled back. The
      // client receives a stable code, never a raw storage error. Retrying the
      // same snapshot only repairs this event while this exact selection remains
      // active; after supersession it creates a new selection and evidence ID.
      evidenceRecorded = false;
      evidenceError = 'EVIDENCE_PERSISTENCE_FAILED';
      logger.error('Selection evidence recording failed', {
        selectionId: outcome.selection.id,
        intentId,
        snapshotId: outcome.selection.snapshotId,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }

    res
      .status(outcome.kind === 'ACTIVATED' ? 201 : 200)
      .json({
        selection: toView(outcome.selection),
        evidenceRecorded,
        ...(evidenceError ? { evidenceError } : {}),
      });
  } catch (err) {
    // Express 4 does not forward rejected async handlers to the error middleware.
    // Keep this boundary here so storage failures return a stable response and
    // cannot become an unhandled rejection or a hung request.
    logger.error('Selection request failed', {
      intentId,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
    if (!res.headersSent) {
      res.status(500).json({ error: 'Selection request failed' });
    }
  }
});

/** Restore the active selection for an owned intent (null when none exists). */
selectionsRouter.get('/:intentId', async (req, res) => {
  const userId = req.auth!.user.id;
  const intentId = req.params.intentId;

  const intent = await getIntentRepository().getByIdForUser(intentId, userId);
  if (!intent) {
    res.status(404).json({ error: 'Intent not found' });
    return;
  }

  const selection = await getSelectionRepository().getActive(intentId, userId);
  res.json({ selection: selection ? toView(selection) : null });
});

/**
 * Full selection history for an owned intent, newest first. Superseded rows are
 * returned unchanged so the audit trail survives every later selection.
 */
selectionsRouter.get('/:intentId/history', async (req, res) => {
  const userId = req.auth!.user.id;
  const intentId = req.params.intentId;

  const intent = await getIntentRepository().getByIdForUser(intentId, userId);
  if (!intent) {
    res.status(404).json({ error: 'Intent not found' });
    return;
  }

  const selections = await getSelectionRepository().listHistory(intentId, userId);
  res.json({ selections: selections.map(toView) });
});
