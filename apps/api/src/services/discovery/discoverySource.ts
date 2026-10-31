import { config } from '../../config/env.js';
import { Channel3Service } from './Channel3Service.js';
import { DemoCatalogService } from './DemoCatalogService.js';
import type { ProductSource } from './ProductDiscoveryService.js';

export type DiscoveryProvider = 'channel3' | 'demo';

/**
 * Resolve which product-discovery provider to use.
 *
 *   - "channel3" -> live Channel3 API. Fails with a clear configuration error
 *                   (Channel3NotConfiguredError) when CHANNEL3_API_KEY is
 *                   missing/invalid; it never returns demo products.
 *   - "demo"     -> in-memory DemoCatalogService, for development/tests only.
 *                   Results are explicitly labelled source=demo_catalog.
 *   - unset      -> Channel3 (the live source). There is deliberately NO
 *                   automatic fallback to demo data; opting into demo must be
 *                   explicit via DISCOVERY_PROVIDER=demo.
 */
export function resolveDiscoveryProvider(
  provider: string = config.discoveryProvider,
): DiscoveryProvider {
  const normalized = provider.trim().toLowerCase();
  if (normalized === '' || normalized === 'channel3') return 'channel3';
  if (normalized === 'demo') return 'demo';
  throw new Error(
    `Unknown DISCOVERY_PROVIDER "${provider}". Expected "channel3" or "demo".`,
  );
}

/** Construct the discovery source for the resolved (or given) provider. */
export function createDiscoverySource(
  provider: DiscoveryProvider = resolveDiscoveryProvider(),
): ProductSource {
  if (provider === 'demo') {
    return new DemoCatalogService();
  }
  return new Channel3Service(config.channel3ApiKey);
}
