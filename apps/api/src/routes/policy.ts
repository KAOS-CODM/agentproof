import { Router } from 'express';
import { policyEvaluateRequestSchema, type Product } from '@agentproof/shared';
import {
  getEvidenceService,
  getIntentRepository,
  getPolicyEvaluationRepository,
  getSelectionRepository,
  getProductRepository,
} from '../models/repositories.js';
import { PolicyEngine } from '../services/policy/PolicyEngine.js';
import { isOfferSnapshotFresh } from '../services/discovery/OfferSnapshot.js';
import { DEFAULT_PRODUCT_MAX_AGE_MS } from '../services/discovery/ProductResolutionService.js';
import { logger } from '../utils/logger.js';
import { requireAuth } from '../middleware/auth.js';

export const policyRouter = Router();
policyRouter.use(requireAuth);

const policyEngine = new PolicyEngine();

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error';
}

policyRouter.post('/evaluate', async (req, res) => {
  // Express 4 does not forward rejected async-handler promises to the error
  // middleware. Every failure path below must therefore answer inside this
  // handler. The outer catch is a last-resort guard for unexpected read/write
  // errors (including the transports behind the repositories) so a rejection
  // can never escape without a response.
  try {
    const parsed = policyEvaluateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
      return;
    }

    const policyEvaluationRepository = getPolicyEvaluationRepository();
    const evidenceService = getEvidenceService();
    const selectionRepository = getSelectionRepository();
    const productRepository = getProductRepository();

    const { intentId } = parsed.data;
    const userId = req.auth!.user.id;

    // The evaluation is only valid for an intent the authenticated user owns.
    const ownedIntent = await getIntentRepository().getByIdForUser(intentId, userId);
    if (!ownedIntent) {
      // Same 404 for unknown and another user's intent: no existence leak.
      res.status(404).json({ error: 'Intent not found' });
      return;
    }

    // Retrieve the active selection for this intent and user.
    const activeSelection = await selectionRepository.getActive(intentId, userId);
    if (!activeSelection) {
      // No active selection: the user must make a selection before policy evaluation.
      res.status(409).json({ error: 'NO_ACTIVE_SELECTION' });
      return;
    }

    // Resolve the exact snapshot bound to the active selection, by its
    // immutable id. This deliberately does not go through the mutable
    // discovery association: re-discovery for the same intent/product replaces
    // that association, and it must never redirect this decision to a newer
    // offer. Ownership is enforced inside the repository; a missing snapshot
    // and a snapshot owned by another user both return null (fail closed, and
    // without leaking another user's data).
    const snapshot = await productRepository.getSnapshotById(
      activeSelection.snapshotId,
      userId,
    );
    if (!snapshot) {
      res.status(404).json({ error: 'SNAPSHOT_NOT_FOUND' });
      return;
    }

    // Defensive invariants: the resolved snapshot must be exactly the one bound
    // to the selection, and must agree with the intent/provider/product recorded
    // on that selection. These are the identity checks the previous
    // association-based lookup performed implicitly. A different snapshot is
    // never substituted.
    if (
      snapshot.id !== activeSelection.snapshotId ||
      snapshot.intentId !== intentId ||
      snapshot.source !== activeSelection.source ||
      snapshot.productId !== activeSelection.productId
    ) {
      res.status(409).json({ error: 'SELECTION_SNAPSHOT_MISMATCH' });
      return;
    }

    // Check freshness of the snapshot against the established maximum age window.
    // A stale offer must not silently replace the selected offer after user selection.
    const nowMs = Date.now();
    if (!isOfferSnapshotFresh(snapshot.capturedAt, nowMs, DEFAULT_PRODUCT_MAX_AGE_MS)) {
      res.status(410).json({ error: 'STALE_SNAPSHOT' });
      return;
    }

    // Build policy-relevant product facts from the immutable snapshot.
    // The engine reads: id, price, currency, brand, condition, category, name.
    // Every available fact comes from the snapshot, never from the request body or
    // the mutable shared Product row.
    //
    // OfferSnapshot does not capture `category`, and no schema change is
    // authorized for this phase. Category is therefore treated as unknown (''):
    // the PURPOSE rule can only match the immutable `productName`. For the same
    // product name, an unknown category is strictly narrower than a known one (a
    // non-empty purpose word can never match ''), so the conservative outcome is
    // a possible false DENY, never a widened ALLOW. No client-supplied or
    // mutable category is ever substituted.
    const policyProduct: Product = {
      id: snapshot.productId,
      source: snapshot.source,
      name: snapshot.productName,
      description: '',
      price: snapshot.price,
      currency: snapshot.currency,
      brand: snapshot.brand,
      condition: snapshot.condition ?? 'unknown',
      category: '',
    };

    // Run the existing PolicyEngine with the persisted, authenticated intent's
    // structured intent (server-side truth) and the snapshot-derived product.
    // The request body's `structuredIntent` is never used for the decision.
    const evaluation = policyEngine.evaluate(ownedIntent.structured, policyProduct);
    evaluation.intentId = intentId;

    // Immediately before persisting, re-read the active selection to detect changes
    // that may have occurred between the initial read and the persist attempt.
    // Compare the stable row identity as well as the bound snapshot: either change
    // means this evaluation no longer describes the user's current selection.
    // Do not replace, supersede, or otherwise mutate the user's selection.
    const activeSelectionAfter = await selectionRepository.getActive(intentId, userId);
    if (
      !activeSelectionAfter ||
      activeSelectionAfter.id !== activeSelection.id ||
      activeSelectionAfter.snapshotId !== activeSelection.snapshotId
    ) {
      res.status(409).json({ error: 'SELECTION_CHANGED' });
      return;
    }

    // Persist the evaluation using the existing evaluation repository.
    // A failure here means nothing durable was written, so the response must
    // not claim that an evaluation was saved.
    try {
      await policyEvaluationRepository.save(evaluation, userId);
    } catch (err) {
      logger.error('Policy evaluation persistence failed', {
        evaluationId: evaluation.id,
        intentId,
        selectionId: activeSelection.id,
        snapshotId: snapshot.id,
        error: errorMessage(err),
      });
      res.status(500).json({ error: 'POLICY_EVALUATION_PERSISTENCE_FAILED' });
      return;
    }

    // After successful evaluation persistence, record the POLICY_EVALUATED evidence
    // event. Include the persisted policyEvaluationId and the relevant selectionId
    // and snapshotId in the supported evidence data payload for auditability.
    try {
      await evidenceService.record(
        {
          eventType: 'POLICY_EVALUATED',
          actor: 'policy_engine',
          source: 'policy_engine',
          intentId,
          policyEvaluationId: evaluation.id,
          data: {
            productId: snapshot.productId,
            selectionId: activeSelection.id,
            snapshotId: snapshot.id,
            result: evaluation.result,
            confirmationRequired: evaluation.confirmationRequired,
            ruleResults: evaluation.ruleResults,
          },
        },
        userId,
      );
    } catch (err) {
      // The evaluation was already persisted successfully; only the audit event
      // failed. Report the partial success explicitly rather than claiming a
      // complete success or a failed (unpersisted) evaluation. The evaluation is
      // returned so the decision remains usable, and the evaluation id lets an
      // operator correlate the missing evidence event.
      logger.error('Policy evaluation evidence recording failed', {
        evaluationId: evaluation.id,
        intentId,
        selectionId: activeSelection.id,
        snapshotId: snapshot.id,
        error: errorMessage(err),
      });
      res.status(500).json({
        error: 'EVALUATION_PERSISTED_EVIDENCE_FAILED',
        evaluationId: evaluation.id,
        evaluation,
      });
      return;
    }

    logger.info('Policy evaluated', {
      evaluationId: evaluation.id,
      result: evaluation.result,
      confirmationRequired: evaluation.confirmationRequired,
    });

    res.json(evaluation);
  } catch (err) {
    logger.error('Policy evaluation failed', {
      error: errorMessage(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    if (!res.headersSent) {
      res.status(500).json({ error: 'POLICY_EVALUATION_FAILED' });
    }
  }
});
