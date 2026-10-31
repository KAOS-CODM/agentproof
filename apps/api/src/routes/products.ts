import { Router } from 'express';
import { z } from 'zod';
import {
  productDiscoverRequestSchema,
  type OfferSnapshotView,
  type PolicyEvaluation,
  type Product,
} from '@agentproof/shared';
import { config } from '../config/env.js';
import {
  getAIService,
  getDiscoveryService,
  getEvidenceService,
  getIntentRepository,
  getPolicyEvaluationRepository,
  getProductRepository,
} from '../models/repositories.js';
import { PolicyEngine } from '../services/policy/PolicyEngine.js';
import { DiscoveryFlowService } from '../services/discovery/DiscoveryFlowService.js';
import { toOfferSnapshotView } from '../services/discovery/OfferSnapshot.js';
import { isOfferSnapshotFresh } from '../services/discovery/OfferSnapshot.js';
import { DEFAULT_PRODUCT_MAX_AGE_MS } from '../services/discovery/ProductResolutionService.js';
import { RetailerHandoffService } from '../services/discovery/RetailerHandoffService.js';
import { logger } from '../utils/logger.js';
import { requireAuth } from '../middleware/auth.js';

export const productsRouter = Router();
productsRouter.use(requireAuth);

const policyEngine = new PolicyEngine();

const retailerHandoffRequestSchema = z.object({
  intentId: z.string().min(1),
  source: z.enum(['channel3', 'demo_catalog']),
  productId: z.string().min(1),
  snapshotId: z.string().min(1),
});

interface CandidateResponse {
  product: Product;
  evaluation: PolicyEvaluation;
  snapshot: OfferSnapshotView | null;
  /** Server-derived: the immutable snapshot exists and is within the freshness window. */
  snapshotFresh: boolean;
  /** Server-derived: a fresh snapshot exists and the handoff feature is enabled. */
  handoffEligible: boolean;
}

function candidateResponse(
  product: Product,
  evaluation: PolicyEvaluation,
  snapshot: OfferSnapshotView | null,
): CandidateResponse {
  const snapshotFresh =
    snapshot !== null &&
    isOfferSnapshotFresh(snapshot.capturedAt, Date.now(), DEFAULT_PRODUCT_MAX_AGE_MS);
  return {
    product,
    evaluation,
    snapshot,
    snapshotFresh,
    handoffEligible: config.retailerHandoffEnabled && snapshotFresh,
  };
}

/**
 * Restore the discovery/policy state for one owned intent.
 *
 * Only products whose exact policy evaluation is still readable by the caller
 * are returned. The order of these checks matters: intent ownership is verified
 * first, then every evaluation is fetched with the same owner scope, so a
 * foreign or ownerless evaluation can never appear in a restored workflow.
 */
productsRouter.get('/discoveries/:intentId', async (req, res) => {
  const intentId = req.params.intentId;
  const userId = req.auth!.user.id;

  const intent = await getIntentRepository().getByIdForUser(intentId, userId);
  if (!intent) {
    // Same 404 for unknown and another user's intent: no existence leak.
    res.status(404).json({ error: 'Intent not found' });
    return;
  }

  const [discovered, evaluations] = await Promise.all([
    getProductRepository().listForIntent(intentId, userId),
    getPolicyEvaluationRepository().listByIntentForUser(intentId, userId),
  ]);
  const evaluationsById = new Map(
    evaluations.map((evaluation) => [evaluation.id, evaluation]),
  );

  const candidates: CandidateResponse[] = [];
  let missingEvaluations = 0;
  for (const entry of discovered) {
    const evaluation = entry.evaluationId
      ? evaluationsById.get(entry.evaluationId)
      : undefined;
    if (!evaluation) {
      missingEvaluations += 1;
      continue;
    }
    candidates.push(
      candidateResponse(
        entry.product,
        evaluation,
        entry.snapshot ? toOfferSnapshotView(entry.snapshot) : null,
      ),
    );
  }

  const allowed = candidates.filter((candidate) => candidate.evaluation.result === 'ALLOW');
  const rejected = candidates.filter((candidate) => candidate.evaluation.result === 'DENY');

  res.json({
    intentId,
    candidates,
    allowed,
    rejected,
    aiRecommendation: null,
    finalEvaluation: null,
    selectedProduct: null,
    decision: allowed.length > 0 ? 'ALLOW' : 'DENY',
    confirmationRequired: allowed.some(
      (candidate) => candidate.evaluation.confirmationRequired,
    ),
    failureReason: null,
    restored: true,
    missingEvaluations,
    handoffEnabled: config.retailerHandoffEnabled,
  });
});

productsRouter.post('/discover', async (req, res) => {
  const parsed = productDiscoverRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }

  const evidenceService = getEvidenceService();
  const productRepository = getProductRepository();
  const intentRepository = getIntentRepository();
  const policyEvaluationRepository = getPolicyEvaluationRepository();
  const userId = req.auth!.user.id;

  // P5: discovery is always tied to an existing, user-owned persisted intent.
  // The intent's stored structured request is authoritative; a client-supplied
  // `structuredIntent` is never used to bypass the persisted intent.
  const intentId = parsed.data.intentId;
  if (!intentId) {
    res.status(400).json({
      error: 'An existing intentId is required for discovery',
    });
    return;
  }

  const intent = await intentRepository.getByIdForUser(intentId, userId);
  if (!intent) {
    // Same 404 for unknown and another user's intent: no existence leak.
    res.status(404).json({ error: 'Intent not found' });
    return;
  }
  const structuredIntent = intent.structured;

  const flow = new DiscoveryFlowService({
    discovery: getDiscoveryService(),
    policyEngine,
    ai: getAIService(),
    evidence: evidenceService,
    userId,
    persistEvaluation: (evaluation) => policyEvaluationRepository.save(evaluation, userId),
  });

  try {
    const result = await flow.run(structuredIntent, intentId);

    // Persist the policy-approved offers as authoritative server-side snapshots
    // so order creation can resolve them later without ever trusting
    // client-supplied price/currency/merchant/URL. Only ALLOW candidates are
    // stored; a client referencing any other id resolves to "not found".
    //
    // The shared offer is refreshed independently of the per-intent discovery
    // association, so another intent discovering the same product cannot erase
    // this intent's association. Each intent discovery also appends an
    // immutable offer snapshot that later shared-offer refreshes cannot mutate.
    const discoveredAt = new Date().toISOString();
    const snapshotsByProductId = new Map<string, OfferSnapshotView>();
    for (const candidate of result.allowed) {
      await productRepository.upsert(candidate.product, {
        discoveredAt,
        discoveredForIntentId: intentId,
        evaluationId: candidate.evaluation.id,
        decision: candidate.evaluation.result,
        confirmationRequired: candidate.evaluation.confirmationRequired,
        userId,
      });

      const snapshot = await productRepository.getSnapshotForIntent(
        intentId,
        candidate.product.source,
        candidate.product.id,
        userId,
      );
      if (snapshot) {
        snapshotsByProductId.set(
          candidate.product.id,
          toOfferSnapshotView(snapshot),
        );
      }
    }

    const withSnapshot = (
      candidate: (typeof result.candidates)[number],
    ): CandidateResponse =>
      candidateResponse(
        candidate.product,
        candidate.evaluation,
        snapshotsByProductId.get(candidate.product.id) ?? null,
      );

    logger.info('Product discovery flow completed', {
      intentId,
      decision: result.decision,
      selectedProductId: result.selectedProduct?.id ?? null,
      allowedCount: result.allowed.length,
      rejectedCount: result.rejected.length,
    });

    res.json({
      intentId: result.intentId,
      candidates: result.candidates.map(withSnapshot),
      allowed: result.allowed.map(withSnapshot),
      rejected: result.rejected.map(withSnapshot),
      aiRecommendation: result.aiRecommendation,
      finalEvaluation: result.finalEvaluation,
      selectedProduct: result.selectedProduct,
      decision: result.decision,
      confirmationRequired: result.confirmationRequired,
      failureReason: result.failureReason,
      handoffEnabled: config.retailerHandoffEnabled,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Discovery flow failed';
    logger.error('Product discovery flow failed', { error: message });
    res.status(502).json({ error: 'Discovery flow failed', details: message });
  }
});

/**
 * Explicit retailer handoff.
 *
 * The client supplies the owned intent, the exact offer identity it is showing,
 * and that offer's immutable snapshot id. The outbound URL comes only from that
 * server-side snapshot, is re-validated here, and is returned as JSON rather
 * than a redirect so this endpoint can never become a general-purpose open
 * redirect.
 */
productsRouter.post('/handoff', async (req, res) => {
  if (!config.retailerHandoffEnabled) {
    // Same 404 whether the feature is off or the route does not exist.
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const parsed = retailerHandoffRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }

  const userId = req.auth!.user.id;
  const { intentId, source, productId, snapshotId } = parsed.data;

  const intent = await getIntentRepository().getByIdForUser(intentId, userId);
  if (!intent) {
    // Same 404 for unknown and another user's intent: no existence leak.
    res.status(404).json({ error: 'Intent not found' });
    return;
  }

  try {
    const service = new RetailerHandoffService({
      repository: getProductRepository(),
      evidence: getEvidenceService(),
      userId,
      source,
      allowedTrackingHosts: config.channel3AllowedLinkHosts,
    });
    const result = await service.prepare({ intentId, productId, snapshotId });

    if (result.kind === 'ISSUED') {
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        url: result.url,
        disclosure: result.disclosure,
        offer: result.offer,
      });
      return;
    }

    if (result.kind === 'NO_SNAPSHOT' || result.kind === 'NO_OFFER_URL') {
      res.status(409).json({
        error:
          result.kind === 'NO_SNAPSHOT'
            ? 'No immutable offer snapshot is available for this product; re-run discovery.'
            : 'This offer has no retailer URL.',
        code: result.kind,
      });
      return;
    }

    if (result.kind === 'SNAPSHOT_MISMATCH') {
      res.status(409).json({
        error: 'The offer snapshot does not match the selected intent, source, and product.',
        code: result.kind,
      });
      return;
    }

    if (result.kind === 'STALE') {
      res.status(409).json({
        error: 'This offer snapshot is older than the freshness window; re-run discovery.',
        code: result.kind,
      });
      return;
    }

    if (result.kind === 'INVALID_SNAPSHOT') {
      res.status(422).json({
        error: 'The stored offer snapshot is invalid; re-run discovery.',
        code: result.kind,
      });
      return;
    }

    res.status(409).json({
      error: 'The retailer link for this offer is not approved.',
      code: 'UNSAFE_URL',
      reason: result.reason,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Retailer handoff failed';
    logger.error('Retailer handoff failed', { error: message });
    res.status(502).json({ error: 'Retailer handoff could not be prepared' });
  }
});
