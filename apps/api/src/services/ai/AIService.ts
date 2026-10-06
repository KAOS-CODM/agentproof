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
}
