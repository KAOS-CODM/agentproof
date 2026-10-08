import { structuredIntentSchema, type StructuredIntent } from '@agentproof/shared';
import { OpenRouterClient } from './OpenRouterClient.js';

const SYSTEM_PROMPT = [
  'You are an intent parser for an agentic commerce system.',
  'Given a user\'s raw purchasing request, extract a structured intent as a single JSON object with exactly these fields:',
  '{',
  '  "purpose": string (short summary of what the user wants to buy),',
  '  "maxAmount": number (maximum price the user is willing to pay),',
  '  "currency": string (ISO 4217 currency code, 3 letters, e.g. "USD"),',
  '  "brands": string[] (brand names the user prefers or specified, empty array if none),',
  '  "condition": "new" | "used" | "any",',
  '  "requiresConfirmationAbove": number | null (price above which human confirmation is required),',
  '  "constraints": [ { "type": string, "value": string | number | string[], "operator": "eq" | "lt" | "lte" | "gt" | "gte" | "in" } ]',
  '}',
  'Respond with only the JSON object, no markdown, no commentary.',
].join('\n');

export interface ParsedIntent {
  structured: StructuredIntent;
  model: string;
  rawResponse: string;
}

export interface ProductRecommendation {
  productId: string;
  model: string;
  rawResponse: string;
}

export interface ProductCandidate {
  id: string;
  name: string;
  brand: string;
  price: number;
  currency: string;
  condition: string;
  category: string;
}

export interface RecommendableAIService {
  recommendProduct(intent: StructuredIntent, allowed: ProductCandidate[]): Promise<ProductRecommendation>;
}

export class AIService {
  private client: OpenRouterClient;

  constructor(client: OpenRouterClient = new OpenRouterClient()) {
    this.client = client;
  }

  async parseIntent(rawInput: string): Promise<ParsedIntent> {
    const result = await this.client.chatCompletion({
      responseFormatJson: true,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: rawInput },
      ],
    });

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(result.content);
    } catch {
      throw new Error('AI response was not valid JSON');
    }

    const structured = structuredIntentSchema.parse(parsedJson);
    return { structured, model: result.model, rawResponse: result.content };
  }

  /**
   * Recommend ONE candidate from the allowed list. The AI is advisory only:
   * the returned ID is validated against the allowed candidates and forced
   * through the PolicyEngine again by the caller. Unknown IDs fail closed.
   */
  async recommendProduct(
    intent: StructuredIntent,
    allowed: ProductCandidate[],
  ): Promise<ProductRecommendation> {
    if (allowed.length === 0) {
      throw new Error('No allowed candidates to recommend from');
    }

    const candidateLines = allowed
      .map(
        (p) =>
          `- id=${p.id} | ${p.name} | ${p.brand} | ${p.price} ${p.currency} | condition=${p.condition} | category=${p.category}`,
      )
      .join('\n');

    const result = await this.client.chatCompletion({
      responseFormatJson: true,
      responseSchema: {
        name: 'product_recommendation',
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['productId'],
          properties: { productId: { type: 'string' } },
        },
      },
      messages: [
        {
          role: 'system',
          content: [
            'You are a product recommender for an agentic commerce system.',
            'Given the user intent and the list of ALLOWED candidate products, choose the single best match.',
            'Respond with only a JSON object: { "productId": "<exact id from the allowed list>" }.',
            'Never invent an ID. Never pick a product not in the list.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            `Intent: ${JSON.stringify(intent)}`,
            'Allowed candidates:',
            candidateLines,
          ].join('\n'),
        },
      ],
    });

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(result.content);
    } catch {
      throw new Error('AI recommendation was not valid JSON');
    }

    const productId = (parsedJson as { productId?: unknown }).productId;
    if (typeof productId !== 'string' || productId.length === 0) {
      throw new Error('AI recommendation did not contain a productId');
    }

    const exists = allowed.some((p) => p.id === productId);
    if (!exists) {
      throw new Error(`AI recommended unknown product ID: ${productId}`);
    }

    return { productId, model: result.model, rawResponse: result.content };
  }
}
