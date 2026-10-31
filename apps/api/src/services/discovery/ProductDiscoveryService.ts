import type { Product, StructuredIntent } from '@agentproof/shared';

export interface ProductSource {
  search(intent: StructuredIntent): Promise<Product[]>;
}

/**
 * ProductDiscoveryService: queries the configured discovery source and
 * returns normalized shared `Product` objects. It makes NO authorization
 * decisions and does NOT rank/select - selection policy lives in PolicyEngine
 * and the AI recommendation layer.
 *
 * The source is required: there is no implicit demo-catalog default. Callers
 * choose a provider explicitly via `createDiscoverySource()`.
 */
export class ProductDiscoveryService {
  private readonly source: ProductSource;

  constructor(source: ProductSource) {
    this.source = source;
  }

  async search(intent: StructuredIntent): Promise<Product[]> {
    return this.source.search(intent);
  }
}
