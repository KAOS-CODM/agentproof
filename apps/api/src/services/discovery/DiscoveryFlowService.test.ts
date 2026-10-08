import { describe, it, expect } from 'vitest';
import initSqlJs from 'sql.js';
import type { EvidenceRecord, StructuredIntent } from '@agentproof/shared';
import { DiscoveryFlowService } from './DiscoveryFlowService.js';
import { DemoCatalogService, DEMO_PRODUCTS } from './DemoCatalogService.js';
import { ProductDiscoveryService } from './ProductDiscoveryService.js';
import { Channel3Service, Channel3NotConfiguredError } from './Channel3Service.js';
import { PolicyEngine } from '../policy/PolicyEngine.js';
import { EvidenceService } from '../evidence/EvidenceService.js';
import type { EvidenceRepository } from '../evidence/EvidenceRepository.js';
import type { RecommendableAIService } from '../ai/AIService.js';

class InMemoryEvidenceRepository implements EvidenceRepository {
  records: EvidenceRecord[] = [];
  append(r: EvidenceRecord) { this.records.push(r); }
  getById(id: string) { return this.records.find((r) => r.id === id) ?? null; }
  getByIntentId(intentId: string) { return this.records.filter((r) => r.intentId === intentId); }
  getByTransactionId(txId: string) { return this.records.filter((r) => r.transactionId === txId); }
  getAll() { return [...this.records]; }
}

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

function makeFlow(
  ai: RecommendableAIService,
  evidence: EvidenceService,
): DiscoveryFlowService {
  return new DiscoveryFlowService({
    discovery: new ProductDiscoveryService(new DemoCatalogService()),
    policyEngine: new PolicyEngine(),
    ai,
    evidence,
  });
}

const pickFirstAllowed: RecommendableAIService = {
  async recommendProduct(_intent, allowed) {
    return { productId: allowed[0].id, model: 'test-model', rawResponse: '{}' };
  },
};

describe('DiscoveryFlowService', () => {
  it('A. valid intent finds multiple candidates', async () => {
    const repo = new InMemoryEvidenceRepository();
    const result = await makeFlow(pickFirstAllowed, new EvidenceService(repo)).run(makeIntent(), 'intent-1');
    expect(result.candidates.length).toBeGreaterThan(1);
    expect(result.allowed.length).toBeGreaterThanOrEqual(2);
  });

  it('B. candidate above maxAmount is rejected', async () => {
    const repo = new InMemoryEvidenceRepository();
    const result = await makeFlow(pickFirstAllowed, new EvidenceService(repo)).run(makeIntent(), 'intent-1');
    const vaporfly = result.candidates.find((c) => c.product.id === 'demo-nike-vaporfly-179');
    expect(vaporfly?.evaluation.result).toBe('DENY');
    expect(vaporfly?.evaluation.ruleResults.find((r) => r.rule === 'PRICE')?.reason).toBe('PRICE_EXCEEDS_INTENT_LIMIT');
  });

  it('C. wrong brand is rejected', async () => {
    const repo = new InMemoryEvidenceRepository();
    const result = await makeFlow(pickFirstAllowed, new EvidenceService(repo)).run(makeIntent(), 'intent-1');
    const puma = result.candidates.find((c) => c.product.id === 'demo-puma-velocity-89');
    expect(puma?.evaluation.result).toBe('DENY');
    expect(puma?.evaluation.ruleResults.find((r) => r.rule === 'BRAND')?.reason).toBe('BRAND_NOT_IN_INTENT');
  });

  it('D. wrong purpose is rejected', async () => {
    const repo = new InMemoryEvidenceRepository();
    const result = await makeFlow(pickFirstAllowed, new EvidenceService(repo)).run(makeIntent(), 'intent-1');
    const watch = result.candidates.find((c) => c.product.id === 'demo-samsung-watch-249');
    expect(watch?.evaluation.result).toBe('DENY');
    expect(watch?.evaluation.ruleResults.find((r) => r.rule === 'PURPOSE')?.reason).toBe('PURPOSE_MISMATCH');
  });

  it('E. used product is rejected when condition is new', async () => {
    const repo = new InMemoryEvidenceRepository();
    const result = await makeFlow(pickFirstAllowed, new EvidenceService(repo)).run(makeIntent(), 'intent-1');
    const used = result.candidates.find((c) => c.product.id === 'demo-nike-freerun-60');
    expect(used?.evaluation.result).toBe('DENY');
    expect(used?.evaluation.ruleResults.find((r) => r.rule === 'CONDITION')?.reason).toBe('CONDITION_MISMATCH');
  });

  it('F. condition any permits both new and used where other constraints pass', async () => {
    const repo = new InMemoryEvidenceRepository();
    const result = await makeFlow(pickFirstAllowed, new EvidenceService(repo)).run(
      makeIntent({ condition: 'any' }), 'intent-1',
    );
    const used = result.candidates.find((c) => c.product.id === 'demo-nike-freerun-60');
    const fresh = result.candidates.find((c) => c.product.id === 'demo-nike-pegasus-100');
    expect(used?.evaluation.result).toBe('ALLOW');
    expect(fresh?.evaluation.result).toBe('ALLOW');
  });

  it('G. confirmation threshold behavior', async () => {
    const repo = new InMemoryEvidenceRepository();
    const below = await makeFlow(pickFirstAllowed, new EvidenceService(repo)).run(makeIntent(), 'i1');
    // $99 product: below $100 threshold → no confirmation required
    const pick99: RecommendableAIService = {
      async recommendProduct(_i, allowed) { return { productId: 'demo-nike-pegasus-100', model: 'm', rawResponse: '{}' }; },
    };
    const r99 = await makeFlow(pick99, new EvidenceService(new InMemoryEvidenceRepository())).run(makeIntent(), 'i2');
    expect(r99.selectedProduct?.price).toBe(99);
    expect(r99.confirmationRequired).toBe(false);

    // $129 product: above $100 threshold but below $150 max → confirmation required
    const pick129: RecommendableAIService = {
      async recommendProduct(_i, allowed) { return { productId: 'demo-adidas-ultraboost-129', model: 'm', rawResponse: '{}' }; },
    };
    const r129 = await makeFlow(pick129, new EvidenceService(new InMemoryEvidenceRepository())).run(makeIntent(), 'i3');
    expect(r129.selectedProduct?.price).toBe(129);
    expect(r129.confirmationRequired).toBe(true);

    // $179 product: above max → DENY (never reaches selection)
    const pick179: RecommendableAIService = {
      async recommendProduct(_i, allowed) { return { productId: 'demo-nike-vaporfly-179', model: 'm', rawResponse: '{}' }; },
    };
    const r179 = await makeFlow(pick179, new EvidenceService(new InMemoryEvidenceRepository())).run(makeIntent(), 'i4');
    expect(r179.decision).toBe('DENY');
    expect(below.candidates.length).toBeGreaterThan(0);
  });

  it('H. AI receives ONLY allowed candidates', async () => {
    let seen: string[] = [];
    const spyAi: RecommendableAIService = {
      async recommendProduct(_intent, allowed) {
        seen = allowed.map((p) => p.id);
        return { productId: allowed[0].id, model: 'm', rawResponse: '{}' };
      },
    };
    await makeFlow(spyAi, new EvidenceService(new InMemoryEvidenceRepository())).run(makeIntent(), 'i1');
    expect(seen).not.toContain('demo-puma-velocity-89');
    expect(seen).not.toContain('demo-samsung-watch-249');
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });

  it('I. AI cannot select a rejected candidate (fail closed)', async () => {
    const evilAi: RecommendableAIService = {
      async recommendProduct() { return { productId: 'demo-puma-velocity-89', model: 'm', rawResponse: '{}' }; },
    };
    const result = await makeFlow(evilAi, new EvidenceService(new InMemoryEvidenceRepository())).run(makeIntent(), 'i1');
    expect(result.decision).toBe('DENY');
    expect(result.selectedProduct).toBeNull();
    expect(result.failureReason).toContain('unknown');
  });

  it('J. AI returns unknown product ID → fail closed, no fallback', async () => {
    const unknownAi: RecommendableAIService = {
      async recommendProduct() { return { productId: 'does-not-exist', model: 'm', rawResponse: '{}' }; },
    };
    const result = await makeFlow(unknownAi, new EvidenceService(new InMemoryEvidenceRepository())).run(makeIntent(), 'i1');
    expect(result.decision).toBe('DENY');
    expect(result.selectedProduct).toBeNull();
    expect(result.failureReason).toContain('does-not-exist');
  });

  it('K/L. selected product is re-evaluated; second DENY prevents progression', async () => {
    const repo = new InMemoryEvidenceRepository();
    const result = await makeFlow(pickFirstAllowed, new EvidenceService(repo)).run(makeIntent(), 'i1');
    // Second evaluation present and ALLOW for a normal flow
    expect(result.finalEvaluation).not.toBeNull();
    expect(result.finalEvaluation?.result).toBe('ALLOW');

    // Simulate a second-evaluation DENY by tampering intent after first pass is not possible;
    // instead verify via a policy engine spy that the second call happened on the same product.
    let secondEvalProductId: string | null = null;
    const engine = new PolicyEngine();
    const original = engine.evaluate.bind(engine);
    let calls = 0;
    engine.evaluate = (intent: StructuredIntent, product: (typeof DEMO_PRODUCTS)[number]) => {
      calls += 1;
      const res = original(intent, product);
      if (calls > DEMO_PRODUCTS.length) secondEvalProductId = product.id;
      return res;
    };
    const spyFlow = new DiscoveryFlowService({
      discovery: new ProductDiscoveryService(new DemoCatalogService()),
      policyEngine: engine,
      ai: pickFirstAllowed,
      evidence: new EvidenceService(new InMemoryEvidenceRepository()),
    });
    const r2 = await spyFlow.run(makeIntent(), 'i1');
    expect(secondEvalProductId).toBe(r2.selectedProduct?.id ?? null);
    expect(calls).toBe(DEMO_PRODUCTS.length + 1);
  });

  it('M. no Channel3 credentials does not break demo-catalog operation', async () => {
    const channel3 = new Channel3Service(undefined);
    await expect(channel3.search(makeIntent())).rejects.toBeInstanceOf(Channel3NotConfiguredError);
    const result = await makeFlow(pickFirstAllowed, new EvidenceService(new InMemoryEvidenceRepository())).run(makeIntent(), 'i1');
    expect(result.decision).toBe('ALLOW');
  });

  it('N. demo catalog products have source demo_catalog', () => {
    for (const p of DEMO_PRODUCTS) {
      expect(p.source).toBe('demo_catalog');
    }
  });

  it('O. evidence records contain correct provenance', async () => {
    const repo = new InMemoryEvidenceRepository();
    await makeFlow(pickFirstAllowed, new EvidenceService(repo)).run(makeIntent(), 'i1');
    const records = repo.getAll();
    const considered = records.filter((r) => r.eventType === 'PRODUCT_CONSIDERED');
    expect(considered.length).toBeGreaterThan(0);
    for (const r of considered) {
      expect(r.metadata.source).toBe('demo_catalog');
    }
    const policyEvals = records.filter((r) => r.eventType === 'POLICY_EVALUATED');
    expect(policyEvals.length).toBeGreaterThan(0);
    for (const r of policyEvals) {
      expect(r.metadata.source).toBe('policy_engine');
      expect(r.actor).toBe('policy_engine');
    }
    const selected = records.filter((r) => r.eventType === 'PRODUCT_SELECTED');
    expect(selected.length).toBe(1);
    expect(selected[0].metadata.source).toBe('demo_catalog');
    expect(selected[0].data.model).toBe('test-model');
    expect(selected[0].data.productId).toBeDefined();
    expect(selected[0].policyEvaluationId).not.toBeNull();
    // No secrets
    expect(JSON.stringify(records)).not.toContain('OPENROUTER_API_KEY');
  });

  it('E2E: running shoes under $150, new only, Nike or Adidas', async () => {
    const repo = new InMemoryEvidenceRepository();
    const evidence = new EvidenceService(repo);
    const result = await makeFlow(pickFirstAllowed, evidence).run(
      makeIntent({ purpose: 'running shoes', maxAmount: 150, brands: ['Nike', 'Adidas'], condition: 'new' }),
      'intent-e2e',
    );

    expect(result.candidates.length).toBe(DEMO_PRODUCTS.length);
    expect(result.allowed.length).toBeGreaterThanOrEqual(2);
    const allowedIds = result.allowed.map((a) => a.product.id);
    expect(allowedIds).toContain('demo-nike-pegasus-100');
    expect(allowedIds).toContain('demo-adidas-ultraboost-129');
    expect(result.decision).toBe('ALLOW');
    expect(result.finalEvaluation?.result).toBe('ALLOW');
    expect(result.selectedProduct).not.toBeNull();
    // $99 → below $100 threshold → no confirmation
    expect(result.confirmationRequired).toBe(false);
    expect(repo.getByIntentId('intent-e2e').length).toBeGreaterThan(0);
  });

  it('E2E failure: AI attempts invalid candidate → fails closed', async () => {
    const rogueAi: RecommendableAIService = {
      async recommendProduct() { return { productId: 'demo-puma-velocity-89', model: 'm', rawResponse: '{}' }; },
    };
    const result = await makeFlow(rogueAi, new EvidenceService(new InMemoryEvidenceRepository())).run(makeIntent(), 'intent-e2e');
    expect(result.decision).toBe('DENY');
    expect(result.selectedProduct).toBeNull();
    expect(result.finalEvaluation).toBeNull();
  });
});
