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
});
