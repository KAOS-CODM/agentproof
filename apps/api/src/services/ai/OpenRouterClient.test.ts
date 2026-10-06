import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenRouterClient, STRUCTURED_INTENT_JSON_SCHEMA } from './OpenRouterClient.js';

const messages = [{ role: 'user' as const, content: 'Buy shoes' }];

function makeClient(timeoutMs?: number): OpenRouterClient {
  return new OpenRouterClient('test-key', 'test-model', timeoutMs);
}

function stubFetch(impl: (...args: unknown[]) => Promise<unknown>): ReturnType<typeof vi.fn> {
  const mock = vi.fn(impl);
  vi.stubGlobal('fetch', mock);
  return mock;
}

function okResponse() {
  return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) };
}

function lastRequestBody(mock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = mock.mock.calls[0];
  const init = call[1] as { body: string };
  return JSON.parse(init.body);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenRouterClient request format', () => {
  it('sends a strict json_schema response_format named structured_intent', async () => {
    const mock = stubFetch(async () => okResponse());
    await makeClient().chatCompletion({ messages, responseFormatJson: true });

    const body = lastRequestBody(mock);
    const rf = body.response_format as {
      type: string;
      json_schema: { name: string; strict: boolean; schema: Record<string, unknown> };
    };
    expect(rf.type).toBe('json_schema');
    expect(rf.json_schema.name).toBe('structured_intent');
    expect(rf.json_schema.strict).toBe(true);
  });

  it('schema contains all seven required structured-intent fields', async () => {
    const mock = stubFetch(async () => okResponse());
    await makeClient().chatCompletion({ messages, responseFormatJson: true });

    const body = lastRequestBody(mock);
    const schema = (body.response_format as { json_schema: { schema: typeof STRUCTURED_INTENT_JSON_SCHEMA } })
      .json_schema.schema;
    expect(schema.required).toEqual([
      'purpose',
      'maxAmount',
      'currency',
      'brands',
      'condition',
      'requiresConfirmationAbove',
      'constraints',
    ]);
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining([
        'purpose',
        'maxAmount',
        'currency',
        'brands',
        'condition',
        'requiresConfirmationAbove',
        'constraints',
      ]),
    );
  });

  it('requires provider support for sent parameters', async () => {
    const mock = stubFetch(async () => okResponse());
    await makeClient().chatCompletion({ messages, responseFormatJson: true });

    const body = lastRequestBody(mock);
    expect(body.provider).toEqual({ require_parameters: true });
  });

  it('passes an AbortSignal for timeout control', async () => {
    const mock = stubFetch(async () => okResponse());
    await makeClient().chatCompletion({ messages, responseFormatJson: true });

    const init = mock.mock.calls[0][1] as { signal?: AbortSignal };
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('converts a timeout abort into a clear OpenRouter timeout error', async () => {
    stubFetch(async () => {
      throw Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
    });

    await expect(
      makeClient(30_000).chatCompletion({ messages, responseFormatJson: true }),
    ).rejects.toThrow('OpenRouter request timed out after 30000ms');
  });

  it('does not retry or fall back on timeout', async () => {
    const mock = stubFetch(async () => {
      throw Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
    });

    await expect(
      makeClient(30_000).chatCompletion({ messages, responseFormatJson: true }),
    ).rejects.toThrow(/timed out/);
    expect(mock).toHaveBeenCalledTimes(1);
  });
});
