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

    it('matches the brand case-insensitively ("Adidas" vs "adidas")', () => {
      const result = engine.evaluate(
        makeIntent({ brands: ['Adidas'] }),
        makeProduct({ brand: 'adidas' }),
      );
      const brandRule = result.ruleResults.find((r) => r.rule === 'BRAND')!;
      expect(brandRule.passed).toBe(true);
      expect(brandRule.actual).toBe('adidas');
      expect(brandRule.expected).toBe('Adidas');
      expect(result.result).toBe('ALLOW');
    });

    it('trims surrounding whitespace on both the intent and the product brand', () => {
      const result = engine.evaluate(
        makeIntent({ brands: ['  NIKE  '] }),
        makeProduct({ brand: ' Nike ' }),
      );
      const brandRule = result.ruleResults.find((r) => r.rule === 'BRAND')!;
      expect(brandRule.passed).toBe(true);
    });

    it('still rejects a genuinely different brand (exact match, not substring)', () => {
      const result = engine.evaluate(
        makeIntent({ brands: ['Adidas'] }),
        makeProduct({ brand: 'Adidas Originals' }),
      );
      const brandRule = result.ruleResults.find((r) => r.rule === 'BRAND')!;
      expect(brandRule.passed).toBe(false);
      expect(brandRule.reason).toBe('BRAND_NOT_IN_INTENT');
      expect(result.result).toBe('DENY');
    });

    it('rejects an empty product brand when a brand is required', () => {
      const result = engine.evaluate(
        makeIntent({ brands: ['Adidas'] }),
        makeProduct({ brand: '' }),
      );
      const brandRule = result.ruleResults.find((r) => r.rule === 'BRAND')!;
      expect(brandRule.passed).toBe(false);
      expect(brandRule.reason).toBe('BRAND_NOT_IN_INTENT');
      expect(result.result).toBe('DENY');
    });

    it('rejects a whitespace-only product brand when a brand is required', () => {
      const result = engine.evaluate(
        makeIntent({ brands: ['Adidas'] }),
        makeProduct({ brand: '   ' }),
      );
      const brandRule = result.ruleResults.find((r) => r.rule === 'BRAND')!;
      expect(brandRule.passed).toBe(false);
    });

    it('does not treat a missing product brand as a match', () => {
      const result = engine.evaluate(
        makeIntent({ brands: ['Adidas'] }),
        makeProduct({ brand: undefined as unknown as string }),
      );
      const brandRule = result.ruleResults.find((r) => r.rule === 'BRAND')!;
      expect(brandRule.passed).toBe(false);
      expect(brandRule.reason).toBe('BRAND_NOT_IN_INTENT');
    });
  });

  describe('CURRENCY rule', () => {
    it('allows a product whose currency matches the intent', () => {
      const result = engine.evaluate(
        makeIntent({ currency: 'USD' }),
        makeProduct({ currency: 'USD' }),
      );
      const currencyRule = result.ruleResults.find((r) => r.rule === 'CURRENCY')!;
      expect(currencyRule.passed).toBe(true);
      expect(result.result).toBe('ALLOW');
    });

    it('compares currency case-insensitively and tolerates whitespace', () => {
      const result = engine.evaluate(
        makeIntent({ currency: 'usd' }),
        makeProduct({ currency: ' USD ' }),
      );
      const currencyRule = result.ruleResults.find((r) => r.rule === 'CURRENCY')!;
      expect(currencyRule.passed).toBe(true);
      expect(currencyRule.actual).toBe('USD');
      expect(currencyRule.expected).toBe('USD');
    });

    it('rejects a currency mismatch even when the numeric price is within the limit', () => {
      const result = engine.evaluate(
        makeIntent({ currency: 'USD', maxAmount: 150 }),
        makeProduct({ currency: 'EUR', price: 100 }),
      );
      const currencyRule = result.ruleResults.find((r) => r.rule === 'CURRENCY')!;
      expect(currencyRule.passed).toBe(false);
      expect(currencyRule.reason).toBe('CURRENCY_MISMATCH');
      expect(currencyRule.actual).toBe('EUR');
      expect(currencyRule.expected).toBe('USD');
      // The numeric price rule still passes; the currency mismatch alone denies.
      expect(result.ruleResults.find((r) => r.rule === 'PRICE')!.passed).toBe(true);
      expect(result.result).toBe('DENY');
    });

    it('rejects a currency mismatch when the numeric price is also above the limit', () => {
      const result = engine.evaluate(
        makeIntent({ currency: 'USD', maxAmount: 150 }),
        makeProduct({ currency: 'EUR', price: 200 }),
      );
      expect(result.result).toBe('DENY');
      const failed = result.ruleResults.filter((r) => !r.passed).map((r) => r.rule);
      expect(failed).toContain('CURRENCY');
      expect(failed).toContain('PRICE');
    });

    it('fails closed when the product currency is missing', () => {
      const result = engine.evaluate(
        makeIntent({ currency: 'USD' }),
        makeProduct({ currency: undefined as unknown as string }),
      );
      const currencyRule = result.ruleResults.find((r) => r.rule === 'CURRENCY')!;
      expect(currencyRule.passed).toBe(false);
      expect(currencyRule.reason).toBe('PRODUCT_CURRENCY_INVALID');
      expect(result.result).toBe('DENY');
    });

    it('fails closed when the product currency is empty or malformed', () => {
      const empty = engine.evaluate(makeIntent({ currency: 'USD' }), makeProduct({ currency: '' }));
      const emptyRule = empty.ruleResults.find((r) => r.rule === 'CURRENCY')!;
      expect(emptyRule.passed).toBe(false);
      expect(emptyRule.reason).toBe('PRODUCT_CURRENCY_INVALID');

      const malformed = engine.evaluate(
        makeIntent({ currency: 'USD' }),
        makeProduct({ currency: 'US' }),
      );
      const malformedRule = malformed.ruleResults.find((r) => r.rule === 'CURRENCY')!;
      expect(malformedRule.passed).toBe(false);
      expect(malformedRule.reason).toBe('PRODUCT_CURRENCY_INVALID');
      expect(malformed.result).toBe('DENY');
    });

    it('fails closed when the intent currency is missing or invalid', () => {
      const missing = engine.evaluate(makeIntent({ currency: '' }), makeProduct({ currency: 'USD' }));
      const missingRule = missing.ruleResults.find((r) => r.rule === 'CURRENCY')!;
      expect(missingRule.passed).toBe(false);
      expect(missingRule.reason).toBe('INTENT_CURRENCY_INVALID');
      expect(missing.result).toBe('DENY');

      const invalid = engine.evaluate(
        makeIntent({ currency: 'US' }),
        makeProduct({ currency: 'US' }),
      );
      const invalidRule = invalid.ruleResults.find((r) => r.rule === 'CURRENCY')!;
      expect(invalidRule.passed).toBe(false);
      expect(invalidRule.reason).toBe('INTENT_CURRENCY_INVALID');
      expect(invalid.result).toBe('DENY');
    });

    it('never ALLOWs on a currency mismatch even with otherwise valid brand, condition, purpose, and price', () => {
      const result = engine.evaluate(
        makeIntent({
          currency: 'USD',
          maxAmount: 150,
          brands: ['Nike'],
          condition: 'new',
          purpose: 'running shoes',
        }),
        makeProduct({
          currency: 'EUR',
          brand: 'Nike',
          condition: 'new',
          category: 'running shoes',
          price: 79,
        }),
      );
      expect(result.result).toBe('DENY');
      // Exactly one rule fails: CURRENCY. Everything else would have allowed.
      const failed = result.ruleResults.filter((r) => !r.passed).map((r) => r.rule);
      expect(failed).toEqual(['CURRENCY']);
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

    it('fails closed on an unknown condition when intent requires new', () => {
      const result = engine.evaluate(
        makeIntent({ condition: 'new' }),
        makeProduct({ condition: 'unknown' }),
      );
      const conditionRule = result.ruleResults.find((r) => r.rule === 'CONDITION')!;
      expect(conditionRule.passed).toBe(false);
      expect(conditionRule.reason).toBe('CONDITION_MISMATCH');
      expect(result.result).toBe('DENY');
    });

    it('fails closed on an unknown condition when intent requires used', () => {
      const result = engine.evaluate(
        makeIntent({ condition: 'used', brands: [] }),
        makeProduct({ condition: 'unknown', brand: 'Puma' }),
      );
      const conditionRule = result.ruleResults.find((r) => r.rule === 'CONDITION')!;
      expect(conditionRule.passed).toBe(false);
      expect(conditionRule.reason).toBe('CONDITION_MISMATCH');
    });

    it('allows an unknown condition only when intent specifies any', () => {
      const result = engine.evaluate(
        makeIntent({ condition: 'any' }),
        makeProduct({ condition: 'unknown' }),
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

    it('matches "buy a watch" against Smartwatches category', () => {
      const result = engine.evaluate(
        makeIntent({ purpose: 'buy a watch' }),
        makeProduct({ category: 'Smartwatches', name: 'Samsung Galaxy Watch 7' }),
      );
      const purposeRule = result.ruleResults.find((r) => r.rule === 'PURPOSE')!;
      expect(purposeRule.passed).toBe(true);
    });

    it('matches "get me a watch" against product name containing watch', () => {
      const result = engine.evaluate(
        makeIntent({ purpose: 'get me a watch' }),
        makeProduct({ category: 'Wearables', name: 'Apple Watch Series 9' }),
      );
      const purposeRule = result.ruleResults.find((r) => r.rule === 'PURPOSE')!;
      expect(purposeRule.passed).toBe(true);
    });

    it('still denies when no significant purpose keyword matches', () => {
      const result = engine.evaluate(
        makeIntent({ purpose: 'running shoes' }),
        makeProduct({ category: 'Smartwatches', name: 'Samsung Galaxy Watch 7' }),
      );
      const purposeRule = result.ruleResults.find((r) => r.rule === 'PURPOSE')!;
      expect(purposeRule.passed).toBe(false);
      expect(purposeRule.reason).toBe('PURPOSE_MISMATCH');
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
      expect(result.ruleResults).toHaveLength(5);
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
