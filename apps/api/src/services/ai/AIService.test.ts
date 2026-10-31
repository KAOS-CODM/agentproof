import { describe, it, expect, vi, afterEach } from 'vitest';
import { AIService } from './AIService.js';
import { OpenRouterClient } from './OpenRouterClient.js';

const validIntent = {
  purpose: 'Buy a running shoe',
  maxAmount: 120,
  currency: 'USD',
  brands: ['Nike'],
  condition: 'new',
  requiresConfirmationAbove: 100,
  constraints: [],
};

function makeService(): AIService {
  return new AIService(new OpenRouterClient('test-key', 'test-model'));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AIService.parseIntent', () => {
  it('parses and validates a structured intent from OpenRouter JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          model: 'test-model',
          choices: [{ message: { content: JSON.stringify(validIntent) } }],
        }),
      })),
    );

    const result = await makeService().parseIntent('Buy new Nike running shoes under $120');
    expect(result.structured).toEqual(validIntent);
    expect(result.model).toBe('test-model');
  });

  it('throws when the AI response is not valid JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'not json' } }] }),
      })),
    );

    await expect(makeService().parseIntent('x')).rejects.toThrow('AI response was not valid JSON');
  });

  it('throws when the AI response fails schema validation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"purpose":""}' } }] }),
      })),
    );

    await expect(makeService().parseIntent('x')).rejects.toThrow();
  });

  it('throws when OpenRouter returns a non-OK status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, text: async () => 'boom' })),
    );

    await expect(makeService().parseIntent('x')).rejects.toThrow('status 500');
  });

  it('throws when API key is missing', async () => {
    const service = new AIService(new OpenRouterClient('', 'test-model'));
    await expect(service.parseIntent('x')).rejects.toThrow('OPENROUTER_API_KEY');
  });

  describe('price interpretation', () => {
    async function parseWithContent(content: string) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: true,
          json: async () => ({
            model: 'test-model',
            choices: [{ message: { content } }],
          }),
        })),
      );
      return makeService().parseIntent('test');
    }

    it('"under $150" sets maxAmount to 150 with no price constraint', async () => {
      const result = await parseWithContent(JSON.stringify({
        purpose: 'running shoes',
        maxAmount: 150,
        currency: 'USD',
        brands: [],
        condition: 'any',
        requiresConfirmationAbove: null,
        constraints: [],
      }));
      expect(result.structured.maxAmount).toBe(150);
      expect(result.structured.constraints).toHaveLength(0);
    });

    it('"at least $100" uses a gte constraint, not maxAmount=100', async () => {
      const result = await parseWithContent(JSON.stringify({
        purpose: 'watch',
        maxAmount: 999999,
        currency: 'USD',
        brands: [],
        condition: 'any',
        requiresConfirmationAbove: null,
        constraints: [{ type: 'price', value: 100, operator: 'gte' }],
      }));
      expect(result.structured.maxAmount).toBe(999999);
      expect(result.structured.constraints).toEqual([
        { type: 'price', value: 100, operator: 'gte' },
      ]);
    });

    it('"between $50 and $100" uses gte and lte constraints', async () => {
      const result = await parseWithContent(JSON.stringify({
        purpose: 'shoes',
        maxAmount: 100,
        currency: 'USD',
        brands: [],
        condition: 'any',
        requiresConfirmationAbove: null,
        constraints: [
          { type: 'price', value: 50, operator: 'gte' },
          { type: 'price', value: 100, operator: 'lte' },
        ],
      }));
      expect(result.structured.maxAmount).toBe(100);
      expect(result.structured.constraints).toHaveLength(2);
      expect(result.structured.constraints[0]).toEqual({ type: 'price', value: 50, operator: 'gte' });
      expect(result.structured.constraints[1]).toEqual({ type: 'price', value: 100, operator: 'lte' });
    });

    it('compound intent "shoes and watch" sets isCompound true', async () => {
      const result = await parseWithContent(JSON.stringify({
        purpose: 'shoes and watch',
        isCompound: true,
        maxAmount: 999999,
        currency: 'USD',
        brands: [],
        condition: 'any',
        requiresConfirmationAbove: null,
        constraints: [{ type: 'price', value: 100, operator: 'gte' }],
      }));
      expect(result.structured.isCompound).toBe(true);
      expect(result.structured.constraints).toEqual([{ type: 'price', value: 100, operator: 'gte' }]);
    });

    it('single-product intent has isCompound false or undefined', async () => {
      const result = await parseWithContent(JSON.stringify({
        purpose: 'running shoes',
        isCompound: false,
        maxAmount: 150,
        currency: 'USD',
        brands: [],
        condition: 'any',
        requiresConfirmationAbove: null,
        constraints: [],
      }));
      expect(result.structured.isCompound ?? false).toBe(false);
    });
  });
});
