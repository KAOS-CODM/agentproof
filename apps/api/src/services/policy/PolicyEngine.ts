import type { StructuredIntent, Product, PolicyEvaluation, RuleResult } from '@agentproof/shared';
import { generateId } from '../../utils/id.js';

export interface PolicyEngineResult {
  evaluation: PolicyEvaluation;
}

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Normalized brand key for comparison: trimmed + lower-cased. Returns '' for
 * missing/non-string values so a missing brand can never accidentally match.
 */
function normalizeBrand(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Normalized currency code: trimmed + upper-cased. Returns '' for
 * missing/non-string values; '' is never a valid code (see CURRENCY_PATTERN).
 */
function normalizeCurrency(value: unknown): string {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
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

    // Rule 1: CURRENCY — currency identity is established BEFORE any monetary
    // comparison. Comparing prices across currencies is meaningless without a
    // conversion, which this engine must never perform; a mismatch or an
    // unverifiable code fails closed and can never contribute to an ALLOW.
    ruleResults.push(this.evaluateCurrency(intent, product));

    // Rule 2: PRICE
    ruleResults.push(this.evaluatePrice(intent, product));

    // Rule 3: BRAND
    ruleResults.push(this.evaluateBrand(intent, product));

    // Rule 4: CONDITION
    ruleResults.push(this.evaluateCondition(intent, product));

    // Rule 5: PURPOSE
    ruleResults.push(this.evaluatePurpose(intent, product));

    // Determine overall result
    const allPassed = ruleResults.every((r) => r.passed);
    const result: 'ALLOW' | 'DENY' = allPassed ? 'ALLOW' : 'DENY';

    // Rule 6: CONFIRMATION_THRESHOLD (only relevant if ALLOW)
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

  private evaluateCurrency(intent: StructuredIntent, product: Product): RuleResult {
    // Deterministic currency equality. Both codes are normalized
    // (trimmed + upper-cased) and must be well-formed 3-letter codes. A
    // missing, empty, or malformed code fails closed — without a verifiable
    // currency the engine cannot know the price is comparable, so it must
    // never silently default to a currency (e.g. USD).
    const intentCurrency = normalizeCurrency(intent.currency);
    const productCurrency = normalizeCurrency(product.currency);
    const intentValid = CURRENCY_PATTERN.test(intentCurrency);
    const productValid = CURRENCY_PATTERN.test(productCurrency);

    let reason: string | null = null;
    if (!intentValid) {
      reason = 'INTENT_CURRENCY_INVALID';
    } else if (!productValid) {
      reason = 'PRODUCT_CURRENCY_INVALID';
    } else if (intentCurrency !== productCurrency) {
      reason = 'CURRENCY_MISMATCH';
    }

    return {
      rule: 'CURRENCY',
      passed: reason === null,
      actual: productCurrency,
      expected: intentCurrency,
      reason,
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
    // An intent with no brands places no brand restriction (unchanged).
    if (intent.brands.length === 0) {
      return {
        rule: 'BRAND',
        passed: true,
        actual: product.brand,
        expected: 'any',
        reason: null,
      };
    }

    // Match on a normalized key (trim + lower-case) so casing/whitespace
    // differences such as "Adidas" vs "adidas" no longer cause false
    // rejections. This remains an exact membership test — no substring or
    // fuzzy matching — and a missing/empty product brand can never satisfy a
    // brand-constrained intent.
    const productBrand = normalizeBrand(product.brand);
    const allowedBrands = intent.brands.map((brand) => normalizeBrand(brand));
    const passed = productBrand.length > 0 && allowedBrands.includes(productBrand);

    return {
      rule: 'BRAND',
      passed,
      actual: typeof product.brand === 'string' ? product.brand : '',
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
    // Deterministic purpose check: match significant keywords from the intent
    // purpose against the product category and name. Stop words are filtered out
    // so natural language purposes like "buy a watch" match "Smartwatches".
    // This remains deterministic — no LLM or fuzzy matching involved.
    const stopWords = new Set([
      'a', 'an', 'the', 'buy', 'get', 'me', 'i', 'want', 'need', 'please',
      'can', 'could', 'would', 'should', 'some', 'something', 'for', 'of',
      'to', 'in', 'on', 'at', 'and', 'or', 'is', 'it', 'this', 'that',
      'my', 'our', 'your', 'their', 'new', 'used', 'pair', 'any',
    ]);

    const purposeWords = intent.purpose
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0 && !stopWords.has(w));

    const categoryLower = product.category.toLowerCase();
    const nameLower = product.name.toLowerCase();

    const passed =
      purposeWords.length > 0 &&
      purposeWords.every(
        (word) => categoryLower.includes(word) || nameLower.includes(word),
      );

    return {
      rule: 'PURPOSE',
      passed,
      actual: product.category,
      expected: intent.purpose,
      reason: passed ? null : 'PURPOSE_MISMATCH',
    };
  }
}
