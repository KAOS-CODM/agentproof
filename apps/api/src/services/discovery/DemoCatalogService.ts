import type { Product, StructuredIntent } from '@agentproof/shared';

/**
 * Deterministic in-memory demo catalog.
 *
 * Deliberately contains BOTH valid and invalid products (relative to typical
 * intents) so the PolicyEngine has something to reject. Never claims to be
 * Channel3 data: every product has `source: 'demo_catalog'`.
 */
export const DEMO_PRODUCTS: Product[] = [
  {
    id: 'demo-nike-pegasus-100',
    source: 'demo_catalog',
    name: 'Nike Air Zoom Pegasus 41',
    description: 'Everyday neutral running shoe, new.',
    price: 99,
    currency: 'USD',
    brand: 'Nike',
    condition: 'new',
    category: 'Running Shoes',
  },
  {
    id: 'demo-adidas-ultraboost-129',
    source: 'demo_catalog',
    name: 'Adidas Ultraboost Light',
    description: 'Cushioned running shoe, new.',
    price: 129,
    currency: 'USD',
    brand: 'Adidas',
    condition: 'new',
    category: 'Running Shoes',
  },
  {
    id: 'demo-nike-vaporfly-179',
    source: 'demo_catalog',
    name: 'Nike Vaporfly 3',
    description: 'Race-day running shoe, new.',
    price: 179,
    currency: 'USD',
    brand: 'Nike',
    condition: 'new',
    category: 'Running Shoes',
  },
  {
    id: 'demo-puma-velocity-89',
    source: 'demo_catalog',
    name: 'Puma Velocity Nitro 3',
    description: 'Lightweight running shoe, new.',
    price: 89,
    currency: 'USD',
    brand: 'Puma',
    condition: 'new',
    category: 'Running Shoes',
  },
  {
    id: 'demo-nike-freerun-60',
    source: 'demo_catalog',
    name: 'Nike Free Run 2.0 (used)',
    description: 'Pre-owned running shoe in good condition.',
    price: 60,
    currency: 'USD',
    brand: 'Nike',
    condition: 'used',
    category: 'Running Shoes',
  },
  {
    id: 'demo-adidas-used-70',
    source: 'demo_catalog',
    name: 'Adidas Supernova (used)',
    description: 'Pre-owned running shoe.',
    price: 70,
    currency: 'USD',
    brand: 'Adidas',
    condition: 'used',
    category: 'Running Shoes',
  },
  {
    id: 'demo-samsung-watch-249',
    source: 'demo_catalog',
    name: 'Samsung Galaxy Watch 7',
    description: 'Wearable smartwatch.',
    price: 249,
    currency: 'USD',
    brand: 'Samsung',
    condition: 'new',
    category: 'Smartwatches',
  },
];

export class DemoCatalogService {
  private readonly products: Product[];

  constructor(products: Product[] = DEMO_PRODUCTS) {
    this.products = products;
  }

  async search(_intent: StructuredIntent): Promise<Product[]> {
    // Deterministic: same catalog every time, in insertion order.
    return [...this.products];
  }
}
