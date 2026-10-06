import { describe, it, expect } from 'vitest';
import { PolicyEngine } from './PolicyEngine.js';
import type { StructuredIntent, Product } from '@agentproof/shared';

const engine = new PolicyEngine();

function makeIntent(overrides: Partial<StructuredIntent> = {}): StructuredIntent {
  return {
    purpose: 'running shoes',
    maxAmount: 150,
    currency: 'USD',
    brands: ['Nike', 'Adidas'],
    condition: 'new',
    requiresConfirmationAbove: 100,
    constraints: [],
    ...overrides,
  };
}

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'prod-1',
    source: 'demo_catalog',
    name: 'Nike Running Shoes',
    description: 'Great running shoes',
    price: 129,
    currency: 'USD',
    brand: 'Nike',
    condition: 'new',
    category: 'running shoes',
    ...overrides,
  };
}

describe('PolicyEngine', () => {
  describe('PRICE rule', () => {
    it('allows a product within the price limit', () => {
      const result = engine.evaluate(makeIntent(), makeProduct({ price: 100 }));
      const priceRule = result.ruleResults.find((r) => r.rule === 'PRICE')!;
      expect(priceRule.passed).toBe(true);
      expect(result.result).toBe('ALLOW');
    });

    it('denies a product that exceeds the maximum price', () => {
      const result = engine.evaluate(makeIntent(), makeProduct({ price: 179 }));
      const priceRule = result.ruleResults.find((r) => r.rule === 'PRICE')!;
      expect(priceRule.passed).toBe(false);
      expect(priceRule.reason).toBe('PRICE_EXCEEDS_INTENT_LIMIT');
      expect(result.result).toBe('DENY');
    });

    it('allows a product at exactly the maximum price', () => {
      const result = engine.evaluate(makeIntent(), makeProduct({ price: 150 }));
      const priceRule = result.ruleResults.find((r) => r.rule === 'PRICE')!;
      expect(priceRule.passed).toBe(true);
    });
  });

  describe('BRAND rule', () => {
    it('allows a product from an allowed brand', () => {
      const result = engine.evaluate(makeIntent(), makeProduct({ brand: 'Nike' }));
      const brandRule = result.ruleResults.find((r) => r.rule === 'BRAND')!;
      expect(brandRule.passed).toBe(true);
    });

    it('allows a product from another allowed brand', () => {
      const result = engine.evaluate(makeIntent(), makeProduct({ brand: 'Adidas' }));
      const brandRule = result.ruleResults.find((r) => r.rule === 'BRAND')!;
      expect(brandRule.passed).toBe(true);
    });

    it('denies a product from a disallowed brand', () => {
      const result = engine.evaluate(makeIntent(), makeProduct({ brand: 'Puma' }));
      const brandRule = result.ruleResults.find((r) => r.rule === 'BRAND')!;
      expect(brandRule.passed).toBe(false);
      expect(brandRule.reason).toBe('BRAND_NOT_IN_INTENT');
      expect(result.result).toBe('DENY');
    });

    it('allows any brand when intent has no brand restriction', () => {
      const result = engine.evaluate(
        makeIntent({ brands: [] }),
        makeProduct({ brand: 'Puma' }),
      );
      const brandRule = result.ruleResults.find((r) => r.rule === 'BRAND')!;
      expect(brandRule.passed).toBe(true);
    });
  });

  describe('CONDITION rule', () => {
    it('allows a new product when intent requires new', () => {
      const result = engine.evaluate(
        makeIntent({ condition: 'new' }),
        makeProduct({ condition: 'new' }),
      );
      const conditionRule = result.ruleResults.find((r) => r.rule === 'CONDITION')!;
      expect(conditionRule.passed).toBe(true);
    });

    it('denies a used product when intent requires new', () => {
      const result = engine.evaluate(
        makeIntent({ condition: 'new' }),
        makeProduct({ condition: 'used' }),
      );
      const conditionRule = result.ruleResults.find((r) => r.rule === 'CONDITION')!;
      expect(conditionRule.passed).toBe(false);
      expect(conditionRule.reason).toBe('CONDITION_MISMATCH');
      expect(result.result).toBe('DENY');
    });

    it('allows any condition when intent specifies any', () => {
      const result = engine.evaluate(
        makeIntent({ condition: 'any' }),
        makeProduct({ condition: 'used' }),
      );
      const conditionRule = result.ruleResults.find((r) => r.rule === 'CONDITION')!;
      expect(conditionRule.passed).toBe(true);
    });
  });

  describe('PURPOSE rule', () => {
    it('allows a product matching the purpose', () => {
      const result = engine.evaluate(
        makeIntent({ purpose: 'running shoes' }),
        makeProduct({ category: 'running shoes' }),
      );
      const purposeRule = result.ruleResults.find((r) => r.rule === 'PURPOSE')!;
      expect(purposeRule.passed).toBe(true);
    });

    it('denies a product that does not match the purpose', () => {
      const result = engine.evaluate(
        makeIntent({ purpose: 'running shoes' }),
        makeProduct({ category: 'basketball shoes', name: 'Basketball Shoes Pro' }),
      );
      const purposeRule = result.ruleResults.find((r) => r.rule === 'PURPOSE')!;
      expect(purposeRule.passed).toBe(false);
      expect(purposeRule.reason).toBe('PURPOSE_MISMATCH');
      expect(result.result).toBe('DENY');
    });

    it('matches purpose against product name as well as category', () => {
      const result = engine.evaluate(
        makeIntent({ purpose: 'running' }),
        makeProduct({ category: 'footwear', name: 'Running Shoes Pro' }),
      );
      const purposeRule = result.ruleResults.find((r) => r.rule === 'PURPOSE')!;
      expect(purposeRule.passed).toBe(true);
    });
  });

  describe('CONFIRMATION_THRESHOLD', () => {
    it('does not require confirmation for products under the threshold', () => {
      const result = engine.evaluate(
        makeIntent({ requiresConfirmationAbove: 100 }),
        makeProduct({ price: 79 }),
      );
      expect(result.result).toBe('ALLOW');
      expect(result.confirmationRequired).toBe(false);
    });

    it('requires confirmation for products above the threshold', () => {
      const result = engine.evaluate(
        makeIntent({ requiresConfirmationAbove: 100 }),
        makeProduct({ price: 129 }),
      );
      expect(result.result).toBe('ALLOW');
      expect(result.confirmationRequired).toBe(true);
    });

    it('confirmation threshold does not override maxAmount', () => {
      const result = engine.evaluate(
        makeIntent({ maxAmount: 150, requiresConfirmationAbove: 100 }),
        makeProduct({ price: 179 }),
      );
      expect(result.result).toBe('DENY');
      expect(result.confirmationRequired).toBe(false);
      const priceRule = result.ruleResults.find((r) => r.rule === 'PRICE')!;
      expect(priceRule.reason).toBe('PRICE_EXCEEDS_INTENT_LIMIT');
    });

    it('does not require confirmation when threshold is null', () => {
      const result = engine.evaluate(
        makeIntent({ requiresConfirmationAbove: null }),
        makeProduct({ price: 129 }),
      );
      expect(result.result).toBe('ALLOW');
      expect(result.confirmationRequired).toBe(false);
    });

    it('requires confirmation at exactly the threshold boundary', () => {
      const result = engine.evaluate(
        makeIntent({ requiresConfirmationAbove: 100 }),
        makeProduct({ price: 101 }),
      );
      expect(result.confirmationRequired).toBe(true);
    });

    it('does not require confirmation at exactly the threshold', () => {
      const result = engine.evaluate(
        makeIntent({ requiresConfirmationAbove: 100 }),
        makeProduct({ price: 100 }),
      );
      expect(result.confirmationRequired).toBe(false);
    });
  });

  describe('overall evaluation', () => {
    it('returns ALLOW when all rules pass', () => {
      const result = engine.evaluate(makeIntent(), makeProduct());
      expect(result.result).toBe('ALLOW');
      expect(result.ruleResults).toHaveLength(4);
    });

    it('returns DENY when any rule fails', () => {
      const result = engine.evaluate(
        makeIntent(),
        makeProduct({ price: 200, brand: 'Puma' }),
      );
      expect(result.result).toBe('DENY');
      const failedRules = result.ruleResults.filter((r) => !r.passed);
      expect(failedRules.length).toBeGreaterThanOrEqual(2);
    });

    it('produces deterministic results', () => {
      const intent = makeIntent();
      const product = makeProduct();
      const result1 = engine.evaluate(intent, product);
      const result2 = engine.evaluate(intent, product);
      expect(result1.result).toBe(result2.result);
      expect(result1.ruleResults).toEqual(result2.ruleResults);
      expect(result1.confirmationRequired).toBe(result2.confirmationRequired);
    });
  });
});
