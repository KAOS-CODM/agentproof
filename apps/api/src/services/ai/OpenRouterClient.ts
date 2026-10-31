import { config } from '../../config/env.js';
import { formatTransportDiagnostic } from '../../utils/transportDiagnostics.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_TIMEOUT_MS = 30_000;

// JSON Schema mirror of `structuredIntentSchema` (packages/shared).
// Manually maintained because the schema is small and stable; Zod remains the
// authoritative runtime validation after the model responds.
export const STRUCTURED_INTENT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'purpose',
    'maxAmount',
    'currency',
    'brands',
    'condition',
    'requiresConfirmationAbove',
    'constraints',
  ],
  properties: {
    purpose: { type: 'string', minLength: 1 },
    maxAmount: { type: 'number', exclusiveMinimum: 0 },
    currency: { type: 'string', minLength: 3, maxLength: 3 },
    brands: { type: 'array', items: { type: 'string' } },
    condition: { type: 'string', enum: ['new', 'used', 'any'] },
    requiresConfirmationAbove: {
      anyOf: [{ type: 'number', exclusiveMinimum: 0 }, { type: 'null' }],
    },
    constraints: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'value', 'operator'],
        properties: {
          type: { type: 'string' },
          value: {
            anyOf: [
              { type: 'string' },
              { type: 'number' },
              { type: 'array', items: { type: 'string' } },
            ],
          },
          operator: { type: 'string', enum: ['eq', 'lt', 'lte', 'gt', 'gte', 'in'] },
        },
      },
    },
  },
} as const;

export interface ChatCompletionRequest {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  responseFormatJson?: boolean;
  /** Override the default structured-intent JSON schema for this call. */
  responseSchema?: { name: string; schema: Record<string, unknown> };
}

export interface ChatCompletionResult {
  content: string;
  model: string;
}

export class OpenRouterClient {
  private apiKey: string;
  private model: string;
  private timeoutMs: number;

  constructor(
    apiKey: string = config.openrouterApiKey,
    model: string = config.openrouterModel,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    if (!this.apiKey) {
      throw new Error('OPENROUTER_API_KEY is not configured');
    }

    let response: Response;
    try {
      response = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: request.messages,
          ...(request.responseFormatJson
            ? {
                response_format: {
                  type: 'json_schema',
                  json_schema: {
                    name: request.responseSchema?.name ?? 'structured_intent',
                    strict: true,
                    schema: request.responseSchema?.schema ?? STRUCTURED_INTENT_JSON_SCHEMA,
                  },
                },
              }
            : {}),
          // Require provider support for the parameters we send (no silent
          // fallback to providers that ignore response_format / require_parameters).
          provider: { require_parameters: true },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new Error(`OpenRouter request timed out after ${this.timeoutMs}ms`);
      }
      // Diagnostic-only: enrich the original error message with safe transport
      // identifiers (name, cause.code, cause.syscall, cause.hostname) while
      // preserving the error type and stack. HTTP/provider rejections are
      // handled by the !response.ok branch below and never reach this path.
      if (err instanceof Error) {
        const diagnostic = formatTransportDiagnostic(err);
        if (diagnostic) err.message = `${err.message}${diagnostic}`;
      }
      throw err;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`OpenRouter request failed with status ${response.status}: ${body}`);
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      model?: string;
    };

    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('OpenRouter response did not contain message content');
    }

    return { content, model: json.model ?? this.model };
  }
}
