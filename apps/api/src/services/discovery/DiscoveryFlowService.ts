import type { PolicyEvaluation, Product, StructuredIntent } from '@agentproof/shared';
import { PolicyEngine } from '../policy/PolicyEngine.js';
import type { EvidenceService } from '../evidence/EvidenceService.js';
import type { ProductDiscoveryService } from './ProductDiscoveryService.js';
import type { RecommendableAIService, ProductCandidate } from '../ai/AIService.js';

export interface CandidateEvaluation {
  product: Product;
  evaluation: PolicyEvaluation;
}

export interface DiscoveryFlowResult {
  intentId: string;
  candidates: CandidateEvaluation[];
  allowed: CandidateEvaluation[];
  rejected: CandidateEvaluation[];
  aiRecommendation: { productId: string; model: string } | null;
  finalEvaluation: PolicyEvaluation | null;
  selectedProduct: Product | null;
  decision: 'ALLOW' | 'DENY';
  confirmationRequired: boolean;
  failureReason: string | null;
}

export interface DiscoveryFlowDeps {
  discovery: ProductDiscoveryService;
  policyEngine: PolicyEngine;
  ai: RecommendableAIService;
  evidence: EvidenceService;
  /** Trusted owner attached to every evidence record written by this flow. */
  userId?: string | null;
  persistEvaluation?: (evaluation: PolicyEvaluation) => Promise<void>;
}

/**
 * Orchestrates Phase 3:
 *   intent → discovery → PolicyEngine filter → AI recommends → PolicyEngine re-check.
 *
 * The AI is advisory only. PolicyEngine is the sole authorization authority.
 */
export class DiscoveryFlowService {
  constructor(private readonly deps: DiscoveryFlowDeps) {}

  async run(intent: StructuredIntent, intentId: string): Promise<DiscoveryFlowResult> {
    const { discovery, policyEngine, ai, evidence, persistEvaluation } = this.deps;
    const userId = this.deps.userId ?? null;

    if (intent.isCompound) {
      await evidence.record({
        eventType: 'DECISION_GENERATED',
        actor: 'agent',
        source: 'policy_engine',
        intentId,
        data: { decision: 'DENY', reason: 'COMPOUND_INTENT_NOT_SUPPORTED' },
      }, userId);
      return {
        intentId,
        candidates: [],
        allowed: [],
        rejected: [],
        aiRecommendation: null,
        finalEvaluation: null,
        selectedProduct: null,
        decision: 'DENY',
        confirmationRequired: false,
        failureReason: 'COMPOUND_INTENT_NOT_SUPPORTED',
      };
    }

    const products = await discovery.search(intent);

    const candidates: CandidateEvaluation[] = [];
    for (const product of products) {
      await evidence.record(
        {
          eventType: 'PRODUCT_CONSIDERED',
          actor: 'agent',
          source: product.source === 'channel3' ? 'channel3' : 'demo_catalog',
          intentId,
          data: { productId: product.id, name: product.name, price: product.price, brand: product.brand },
        },
        userId,
      );

      const evaluation = policyEngine.evaluate(intent, product);
      evaluation.intentId = intentId;
      await persistEvaluation?.(evaluation);
      await evidence.record(
        {
          eventType: 'POLICY_EVALUATED',
          actor: 'policy_engine',
          source: 'policy_engine',
          intentId,
          policyEvaluationId: evaluation.id,
          data: {
            productId: product.id,
            result: evaluation.result,
            confirmationRequired: evaluation.confirmationRequired,
            ruleResults: evaluation.ruleResults,
          },
        },
        userId,
      );
      candidates.push({ product, evaluation });
    }

    const allowed = candidates.filter((c) => c.evaluation.result === 'ALLOW');
    const rejected = candidates.filter((c) => c.evaluation.result === 'DENY');

    const base = { intentId, candidates, allowed, rejected };

    if (allowed.length === 0) {
      await evidence.record(
        {
          eventType: 'DECISION_GENERATED',
          actor: 'agent',
          // Provenance follows the actual discovery source (never a hard-coded
          // demo_catalog label). Falls back to policy_engine when discovery
          // returned no candidates at all.
          source: candidates[0]?.product.source ?? 'policy_engine',
          intentId,
          data: { decision: 'DENY', reason: 'NO_ALLOWED_CANDIDATES' },
        },
        userId,
      );
      return {
        ...base,
        aiRecommendation: null,
        finalEvaluation: null,
        selectedProduct: null,
        decision: 'DENY',
        confirmationRequired: false,
        failureReason: 'NO_ALLOWED_CANDIDATES',
      };
    }

    // AI receives ONLY allowed candidates.
    const allowedCandidates: ProductCandidate[] = allowed.map(({ product }) => ({
      id: product.id,
      name: product.name,
      brand: product.brand,
      price: product.price,
      currency: product.currency,
      condition: product.condition,
      category: product.category,
    }));

    let recommendation: { productId: string; model: string };
    try {
      recommendation = await ai.recommendProduct(intent, allowedCandidates);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'AI recommendation failed';
      await evidence.record(
        {
          eventType: 'DECISION_GENERATED',
          actor: 'llm',
          source: 'openrouter',
          intentId,
          data: { decision: 'DENY', reason },
        },
        userId,
      );
      return {
        ...base,
        aiRecommendation: null,
        finalEvaluation: null,
        selectedProduct: null,
        decision: 'DENY',
        confirmationRequired: false,
        failureReason: reason,
      };
    }

    const selected = allowed.find((c) => c.product.id === recommendation.productId);
    if (!selected) {
      // Fail closed: unknown or non-allowed ID from the AI.
      await evidence.record(
        {
          eventType: 'DECISION_GENERATED',
          actor: 'llm',
          source: 'openrouter',
          intentId,
          data: { decision: 'DENY', reason: `UNKNOWN_PRODUCT_ID: ${recommendation.productId}` },
        },
        userId,
      );
      return {
        ...base,
        aiRecommendation: { productId: recommendation.productId, model: recommendation.model },
        finalEvaluation: null,
        selectedProduct: null,
        decision: 'DENY',
        confirmationRequired: false,
        failureReason: `AI selected unknown/not-allowed product ID: ${recommendation.productId}`,
      };
    }

    // MANDATORY second policy check on the exact selected product.
    const finalEvaluation = policyEngine.evaluate(intent, selected.product);
    finalEvaluation.intentId = intentId;
    await persistEvaluation?.(finalEvaluation);
    await evidence.record(
      {
        eventType: 'POLICY_EVALUATED',
        actor: 'policy_engine',
        source: 'policy_engine',
        intentId,
        policyEvaluationId: finalEvaluation.id,
        data: {
          productId: selected.product.id,
          result: finalEvaluation.result,
          confirmationRequired: finalEvaluation.confirmationRequired,
          ruleResults: finalEvaluation.ruleResults,
          phase: 'post_recommendation',
        },
      },
      userId,
    );

    if (finalEvaluation.result === 'DENY') {
      await evidence.record(
        {
          eventType: 'DECISION_GENERATED',
          actor: 'agent',
          source: 'policy_engine',
          intentId,
          policyEvaluationId: finalEvaluation.id,
          data: { decision: 'DENY', productId: selected.product.id },
        },
        userId,
      );
      return {
        ...base,
        aiRecommendation: { productId: recommendation.productId, model: recommendation.model },
        finalEvaluation,
        selectedProduct: null,
        decision: 'DENY',
        confirmationRequired: false,
        failureReason: 'SECOND_POLICY_EVALUATION_DENIED',
      };
    }

    // PRODUCT_SELECTED is emitted only by the explicit selection route after the
    // server confirms a real user selection. An AI recommendation or discovery
    // fallback must never produce a user-selection evidence event.
    return {
      ...base,
      aiRecommendation: { productId: recommendation.productId, model: recommendation.model },
      finalEvaluation,
      selectedProduct: selected.product,
      decision: 'ALLOW',
      confirmationRequired: finalEvaluation.confirmationRequired,
      failureReason: null,
    };
  }
}
