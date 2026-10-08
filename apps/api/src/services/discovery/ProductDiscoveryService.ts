import type { Product, StructuredIntent } from '@agentproof/shared';
import { DemoCatalogService } from './DemoCatalogService.js';

export interface ProductSource {
  search(intent: StructuredIntent): Promise<Product[]>;
}

/**
 * ProductDiscoveryService: queries the configured discovery source and
 * returns normalized shared `Product` objects. It makes NO authorization
 * decisions and does NOT rank/select — selection policy lives in PolicyEngine
 * and the AI recommendation layer.
 */
export class ProductDiscoveryService {
  private readonly source: ProductSource;

  constructor(source: ProductSource = new DemoCatalogService()) {
    this.source = source;
  }

  async search(intent: StructuredIntent): Promise<Product[]> {
    return this.source.search(intent);
  }
}
