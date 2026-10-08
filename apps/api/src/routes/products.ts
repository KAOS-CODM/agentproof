import { Router } from 'express';
import { productDiscoverRequestSchema } from '@agentproof/shared';
import { getDb } from '../models/db.js';
import { EvidenceService } from '../services/evidence/EvidenceService.js';
import { SQLiteEvidenceRepository } from '../services/evidence/SQLiteEvidenceRepository.js';
import { PolicyEngine } from '../services/policy/PolicyEngine.js';
import { ProductDiscoveryService } from '../services/discovery/ProductDiscoveryService.js';
import { DiscoveryFlowService } from '../services/discovery/DiscoveryFlowService.js';
import { AIService } from '../services/ai/AIService.js';
import { generateId } from '../utils/id.js';
import { logger } from '../utils/logger.js';

export const productsRouter = Router();

const policyEngine = new PolicyEngine();
const discovery = new ProductDiscoveryService();
const aiService = new AIService();

productsRouter.post('/discover', async (req, res) => {
  const parsed = productDiscoverRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }

  const db = getDb();
  const evidenceService = new EvidenceService(new SQLiteEvidenceRepository(db));

  let structuredIntent = parsed.data.structuredIntent ?? null;
  let intentId = parsed.data.intentId ?? null;

  if (!structuredIntent && intentId) {
    const stmt = db.prepare('SELECT structured_json FROM intents WHERE id = ?');
    stmt.bind([intentId]);
    let row: { structured_json: string } | null = null;
    if (stmt.step()) {
      row = stmt.getAsObject() as unknown as { structured_json: string };
    }
    stmt.free();
    if (!row) {
      res.status(404).json({ error: 'Intent not found' });
      return;
    }
    structuredIntent = JSON.parse(row.structured_json);
  }

  if (!structuredIntent) {
    res.status(400).json({ error: 'Could not resolve structured intent' });
    return;
  }
  if (!intentId) {
    intentId = generateId();
  }

  const flow = new DiscoveryFlowService({
    discovery,
    policyEngine,
    ai: aiService,
    evidence: evidenceService,
    persistEvaluation: (evaluation) => {
      db.run(
        `INSERT INTO policy_evaluations (id, intent_id, product_id, result, confirmation_required, rule_results_json, evaluated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          evaluation.id,
          evaluation.intentId,
          evaluation.productId,
          evaluation.result,
          evaluation.confirmationRequired ? 1 : 0,
          JSON.stringify(evaluation.ruleResults),
          evaluation.evaluatedAt,
        ],
      );
    },
  });

  try {
    const result = await flow.run(structuredIntent, intentId);

    logger.info('Product discovery flow completed', {
      intentId,
      decision: result.decision,
      selectedProductId: result.selectedProduct?.id ?? null,
      allowedCount: result.allowed.length,
      rejectedCount: result.rejected.length,
    });

    res.json({
      intentId: result.intentId,
      candidates: result.candidates.map((c) => ({ product: c.product, evaluation: c.evaluation })),
      allowed: result.allowed.map((c) => ({ product: c.product, evaluation: c.evaluation })),
      rejected: result.rejected.map((c) => ({ product: c.product, evaluation: c.evaluation })),
      aiRecommendation: result.aiRecommendation,
      finalEvaluation: result.finalEvaluation,
      selectedProduct: result.selectedProduct,
      decision: result.decision,
      confirmationRequired: result.confirmationRequired,
      failureReason: result.failureReason,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Discovery flow failed';
    logger.error('Product discovery flow failed', { error: message });
    res.status(502).json({ error: 'Discovery flow failed', details: message });
  }
});
