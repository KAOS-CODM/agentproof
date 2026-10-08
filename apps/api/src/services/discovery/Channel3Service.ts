import type { Product, StructuredIntent } from '@agentproof/shared';

export class Channel3NotConfiguredError extends Error {
  constructor() {
    super(
      'Channel3 integration is not configured. Set CHANNEL3_API_KEY (and related credentials) to enable it. Falling back is not allowed; use the demo catalog source.',
    );
    this.name = 'Channel3NotConfiguredError';
  }
}

/**
 * Future Channel3 integration boundary.
 *
 * Phase 3 intentionally does NOT invent Channel3 endpoints, auth, or payloads.
 * Until real credentials/contract exist, this adapter fails explicitly so the
 * system can never silently fabricate Channel3 data. The demo catalog is the
 * supported source in Phase 3.
 */
export class Channel3Service {
  private readonly configured: boolean;

  constructor(apiKey?: string) {
    this.configured = Boolean(apiKey && apiKey.length > 0);
  }

  async search(_intent: StructuredIntent): Promise<Product[]> {
    if (!this.configured) {
      throw new Channel3NotConfiguredError();
    }
    // Real Channel3 adapter goes here in a later phase once the official API
    // contract is available. Do not guess request/response shapes.
    throw new Channel3NotConfiguredError();
  }
}
