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
  persistEvaluation?: (evaluation: PolicyEvaluation) => void;
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

    const products = await discovery.search(intent);

    const candidates: CandidateEvaluation[] = [];
    for (const product of products) {
      evidence.record({
        eventType: 'PRODUCT_CONSIDERED',
        actor: 'agent',
        source: product.source === 'channel3' ? 'channel3' : 'demo_catalog',
        intentId,
        data: { productId: product.id, name: product.name, price: product.price, brand: product.brand },
      });

      const evaluation = policyEngine.evaluate(intent, product);
      evaluation.intentId = intentId;
      persistEvaluation?.(evaluation);
      evidence.record({
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
      });
      candidates.push({ product, evaluation });
    }

    const allowed = candidates.filter((c) => c.evaluation.result === 'ALLOW');
    const rejected = candidates.filter((c) => c.evaluation.result === 'DENY');

    const base = { intentId, candidates, allowed, rejected };

    if (allowed.length === 0) {
      evidence.record({
        eventType: 'DECISION_GENERATED',
        actor: 'agent',
        source: 'demo_catalog',
        intentId,
        data: { decision: 'DENY', reason: 'NO_ALLOWED_CANDIDATES' },
      });
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
      evidence.record({
        eventType: 'DECISION_GENERATED',
        actor: 'llm',
        source: 'openrouter',
        intentId,
        data: { decision: 'DENY', reason },
      });
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
      evidence.record({
        eventType: 'DECISION_GENERATED',
        actor: 'llm',
        source: 'openrouter',
        intentId,
        data: { decision: 'DENY', reason: `UNKNOWN_PRODUCT_ID: ${recommendation.productId}` },
      });
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
    persistEvaluation?.(finalEvaluation);
    evidence.record({
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
    });

    if (finalEvaluation.result === 'DENY') {
      evidence.record({
        eventType: 'DECISION_GENERATED',
        actor: 'agent',
        source: 'policy_engine',
        intentId,
        policyEvaluationId: finalEvaluation.id,
        data: { decision: 'DENY', productId: selected.product.id },
      });
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

    evidence.record({
      eventType: 'PRODUCT_SELECTED',
      actor: 'agent',
      source: selected.product.source === 'channel3' ? 'channel3' : 'demo_catalog',
      intentId,
      policyEvaluationId: finalEvaluation.id,
      data: {
        productId: selected.product.id,
        productName: selected.product.name,
        price: selected.product.price,
        currency: selected.product.currency,
        model: recommendation.model,
        confirmationRequired: finalEvaluation.confirmationRequired,
      },
    });

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
