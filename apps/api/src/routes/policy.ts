import { Router } from 'express';
import { policyEvaluateRequestSchema } from '@agentproof/shared';
import { getDb } from '../models/db.js';
import { PolicyEngine } from '../services/policy/PolicyEngine.js';
import { EvidenceService } from '../services/evidence/EvidenceService.js';
import { SQLiteEvidenceRepository } from '../services/evidence/SQLiteEvidenceRepository.js';
import { logger } from '../utils/logger.js';

export const policyRouter = Router();

const policyEngine = new PolicyEngine();

policyRouter.post('/evaluate', (req, res) => {
  const parsed = policyEvaluateRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }

  const db = getDb();
  const evidenceService = new EvidenceService(new SQLiteEvidenceRepository(db));

  const { intentId, productId, structuredIntent, product } = parsed.data;

  // Run deterministic policy evaluation
  const evaluation = policyEngine.evaluate(structuredIntent, product);
  evaluation.intentId = intentId;

  // Persist policy evaluation
  db.run(
    `INSERT INTO policy_evaluations (id, intent_id, product_id, result, confirmation_required, rule_results_json, evaluated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      evaluation.id,
      intentId,
      productId,
      evaluation.result,
      evaluation.confirmationRequired ? 1 : 0,
      JSON.stringify(evaluation.ruleResults),
      evaluation.evaluatedAt,
    ],
  );

  // Record evidence
  evidenceService.record({
    eventType: 'POLICY_EVALUATED',
    actor: 'policy_engine',
    source: 'policy_engine',
    intentId,
    policyEvaluationId: evaluation.id,
    data: {
      productId,
      result: evaluation.result,
      confirmationRequired: evaluation.confirmationRequired,
      ruleResults: evaluation.ruleResults,
    },
  });

  logger.info('Policy evaluated', {
    evaluationId: evaluation.id,
    result: evaluation.result,
    confirmationRequired: evaluation.confirmationRequired,
  });

  res.json(evaluation);
});
