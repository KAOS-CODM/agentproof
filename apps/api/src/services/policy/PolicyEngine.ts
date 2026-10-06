import type { StructuredIntent, Product, PolicyEvaluation, RuleResult } from '@agentproof/shared';
import { generateId } from '../../utils/id.js';

export interface PolicyEngineResult {
  evaluation: PolicyEvaluation;
}

/**
 * Deterministic Policy Engine.
 *
 * This is the sole authority for financial decisions.
 * It is pure, deterministic, and has no dependency on any AI/LLM service.
 * Every evaluation is reproducible from structured inputs.
 */
export class PolicyEngine {
  evaluate(intent: StructuredIntent, product: Product): PolicyEvaluation {
    const ruleResults: RuleResult[] = [];

    // Rule 1: PRICE
    ruleResults.push(this.evaluatePrice(intent, product));

    // Rule 2: BRAND
    ruleResults.push(this.evaluateBrand(intent, product));

    // Rule 3: CONDITION
    ruleResults.push(this.evaluateCondition(intent, product));

    // Rule 4: PURPOSE
    ruleResults.push(this.evaluatePurpose(intent, product));

    // Determine overall result
    const allPassed = ruleResults.every((r) => r.passed);
    const result: 'ALLOW' | 'DENY' = allPassed ? 'ALLOW' : 'DENY';

    // Rule 5: CONFIRMATION_THRESHOLD (only relevant if ALLOW)
    let confirmationRequired = false;
    if (allPassed && intent.requiresConfirmationAbove !== null) {
      confirmationRequired = product.price > intent.requiresConfirmationAbove;
    }

    return {
      id: generateId(),
      intentId: '', // Set by caller
      productId: product.id,
      result,
      confirmationRequired,
      ruleResults,
      evaluatedAt: new Date().toISOString(),
    };
  }

  private evaluatePrice(intent: StructuredIntent, product: Product): RuleResult {
    const passed = product.price <= intent.maxAmount;
    return {
      rule: 'PRICE',
      passed,
      actual: product.price,
      expected: intent.maxAmount,
      reason: passed ? null : 'PRICE_EXCEEDS_INTENT_LIMIT',
    };
  }

  private evaluateBrand(intent: StructuredIntent, product: Product): RuleResult {
    if (intent.brands.length === 0) {
      return {
        rule: 'BRAND',
        passed: true,
        actual: product.brand,
        expected: 'any',
        reason: null,
      };
    }
    const passed = intent.brands.includes(product.brand);
    return {
      rule: 'BRAND',
      passed,
      actual: product.brand,
      expected: intent.brands.join(', '),
      reason: passed ? null : 'BRAND_NOT_IN_INTENT',
    };
  }

  private evaluateCondition(intent: StructuredIntent, product: Product): RuleResult {
    const passed =
      intent.condition === 'any' || product.condition === intent.condition;
    return {
      rule: 'CONDITION',
      passed,
      actual: product.condition,
      expected: intent.condition,
      reason: passed ? null : 'CONDITION_MISMATCH',
    };
  }

  private evaluatePurpose(intent: StructuredIntent, product: Product): RuleResult {
    // Deterministic purpose check: product category must contain the purpose string.
    // This is intentionally conservative — it fails closed rather than inventing
    // semantic certainty. Future phases may enhance this with a deterministic
    // taxonomy or ontology, but it will never be an LLM semantic matcher.
    const purposeLower = intent.purpose.toLowerCase();
    const categoryLower = product.category.toLowerCase();
    const nameLower = product.name.toLowerCase();

    const passed =
      categoryLower.includes(purposeLower) || nameLower.includes(purposeLower);

    return {
      rule: 'PURPOSE',
      passed,
      actual: product.category,
      expected: intent.purpose,
      reason: passed ? null : 'PURPOSE_MISMATCH',
    };
  }
}
