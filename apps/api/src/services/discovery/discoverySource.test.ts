import { describe, it, expect } from 'vitest';
import {
  createDiscoverySource,
  resolveDiscoveryProvider,
} from './discoverySource.js';
import { Channel3Service } from './Channel3Service.js';
import { DemoCatalogService } from './DemoCatalogService.js';

describe('resolveDiscoveryProvider', () => {
  it('defaults to the live Channel3 provider when unset', () => {
    expect(resolveDiscoveryProvider('')).toBe('channel3');
  });

  it('honours an explicit provider selection (case/whitespace insensitive)', () => {
    expect(resolveDiscoveryProvider('demo')).toBe('demo');
    expect(resolveDiscoveryProvider('  DEMO ')).toBe('demo');
    expect(resolveDiscoveryProvider('channel3')).toBe('channel3');
  });

  it('rejects unknown provider values instead of guessing', () => {
    expect(() => resolveDiscoveryProvider('staging')).toThrow(/Unknown DISCOVERY_PROVIDER/);
  });
});

describe('createDiscoverySource', () => {
  it('returns the demo catalog only when explicitly selected', () => {
    expect(createDiscoverySource('demo')).toBeInstanceOf(DemoCatalogService);
  });

  it('returns the real Channel3 adapter by default (no implicit demo fallback)', () => {
    expect(createDiscoverySource('channel3')).toBeInstanceOf(Channel3Service);
    expect(createDiscoverySource()).toBeInstanceOf(Channel3Service);
  });
});
