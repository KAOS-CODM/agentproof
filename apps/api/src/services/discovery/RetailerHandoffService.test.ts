import { describe, expect, it, vi } from 'vitest';
import type { Product } from '@agentproof/shared';
import { EvidenceService } from '../evidence/EvidenceService.js';
import { InMemoryEvidenceRepository } from '../../test/inMemoryRepositories.js';
import { createOfferSnapshot } from './OfferSnapshot.js';
import type { ProductRepository } from './ProductRepository.js';
import {
  RETAILER_AFFILIATE_DISCLOSURE,
} from './RetailerHandoffPolicy.js';
import { RetailerHandoffService } from './RetailerHandoffService.js';

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'channel3:runfalcon',
    source: 'channel3',
    name: 'Runfalcon 3.0',
    description: 'Running shoes',
    price: 44.95,
    currency: 'USD',
    brand: 'adidas',
    condition: 'new',
    category: 'Running Shoes',
    merchant: 'shoebacca.com',
    productUrl: 'https://shoebacca.com/p/runfalcon-3?aff=abc',
    availability: 'InStock',
    externalId: '1FesGXD',
    metadata: {
      provider: 'channel3',
      offerDomain: 'shoebacca.com',
      compareAtPrice: 65,
      maxCommissionRate: 0.05,
    },
    ...overrides,
  };
}

function snapshot(overrides: Partial<Product> = {}) {
  return createOfferSnapshot(product(overrides), {
    intentId: 'intent-1',
    userId: 'user-1',
    capturedAt: '2026-10-20T10:00:00.000Z',
  });
}

function serviceWith(
  snapshotValue: ReturnType<typeof snapshot> | null,
  nowMs = Date.parse('2026-10-20T10:30:00.000Z'),
) {
  const repository = {
    getSnapshotById: vi.fn().mockResolvedValue(snapshotValue),
  } as unknown as ProductRepository;
  const evidenceRepository = new InMemoryEvidenceRepository();
  const evidence = new EvidenceService(evidenceRepository);
  const service = new RetailerHandoffService({
    repository,
    evidence,
    userId: 'user-1',
    source: 'channel3',
    allowedTrackingHosts: ['buy.trychannel3.com'],
    now: () => nowMs,
  });
  return { service, repository, evidenceRepository };
}

describe('RetailerHandoffService', () => {
  it('issues the exact snapshot URL and records only a handoff fact', async () => {
    const value = snapshot();
    const { service, evidenceRepository } = serviceWith(value);

    const result = await service.prepare({
      intentId: 'intent-1',
      productId: value.productId,
      snapshotId: value.id,
    });

    expect(result.kind).toBe('ISSUED');
    if (result.kind !== 'ISSUED') return;
    expect(result.url).toBe(value.offerUrl);
    expect(result.disclosure).toBe(RETAILER_AFFILIATE_DISCLOSURE);
    expect(result.offer).toMatchObject({
      id: value.id,
      merchant: 'shoebacca.com',
      price: 44.95,
      currency: 'USD',
      compareAtPrice: 65,
      maxCommissionRate: 0.05,
    });
    expect(result.offer).not.toHaveProperty('offerUrl');

    const records = evidenceRepository.records;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      eventType: 'RETAILER_HANDOFF_PREPARED',
      intentId: 'intent-1',
      actor: 'user',
    });
    expect(records[0].data).toMatchObject({
      snapshotId: value.id,
      productId: value.productId,
      merchant: 'shoebacca.com',
      price: 44.95,
      currency: 'USD',
    });
    expect(String(records[0].data.urlHash)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(records[0].data)).not.toContain(value.offerUrl!);
  });

  it('binds the handoff to the exact owner-scoped snapshot id', async () => {
    const value = snapshot();
    const { service, repository } = serviceWith(value);

    await service.prepare({
      intentId: 'intent-1',
      productId: value.productId,
      snapshotId: value.id,
    });

    expect(repository.getSnapshotById).toHaveBeenCalledWith(value.id, 'user-1');
  });

  it('rejects a snapshot whose intent, source, product, or owner does not match', async () => {
    const cases = [
      {
        intentId: 'intent-2',
        userId: 'user-1',
        source: 'channel3' as const,
        productId: 'channel3:runfalcon',
      },
      {
        intentId: 'intent-1',
        userId: 'user-1',
        source: 'demo_catalog' as const,
        productId: 'channel3:runfalcon',
      },
      {
        intentId: 'intent-1',
        userId: 'user-1',
        source: 'channel3' as const,
        productId: 'channel3:other',
      },
      {
        intentId: 'intent-1',
        userId: 'user-2',
        source: 'channel3' as const,
        productId: 'channel3:runfalcon',
      },
    ];

    for (const mismatch of cases) {
      const value = createOfferSnapshot(
        product({ source: mismatch.source, id: mismatch.productId }),
        {
          intentId: mismatch.intentId,
          userId: mismatch.userId,
          capturedAt: '2026-10-20T10:00:00.000Z',
        },
      );
      const { service, evidenceRepository } = serviceWith(value);
      const result = await service.prepare({
        intentId: 'intent-1',
        productId: 'channel3:runfalcon',
        snapshotId: value.id,
      });
      expect(result.kind).toBe('SNAPSHOT_MISMATCH');
      expect(evidenceRepository.records).toHaveLength(0);
    }
  });

  it('fails closed when no owner-scoped snapshot exists', async () => {
    const { service, evidenceRepository } = serviceWith(null);
    await expect(
      service.prepare({ intentId: 'intent-1', productId: 'channel3:missing', snapshotId: 'snap-missing' }),
    ).resolves.toEqual({ kind: 'NO_SNAPSHOT' });
    expect(evidenceRepository.records).toHaveLength(0);
  });

  it('rejects a snapshot with no retailer URL', async () => {
    const value = snapshot({ productUrl: undefined });
    const { service, evidenceRepository } = serviceWith(value);
    await expect(
      service.prepare({ intentId: 'intent-1', productId: value.productId, snapshotId: value.id }),
    ).resolves.toEqual({ kind: 'NO_OFFER_URL' });
    expect(evidenceRepository.records).toHaveLength(0);
  });

  it('rejects unsafe or unapproved URLs without recording a handoff', async () => {
    for (const offerUrl of [
      'http://shoebacca.com/p/1',
      'javascript:alert(1)',
      'https://user:pass@shoebacca.com/p/1',
      'https://shoebacca.com.evil.example/p/1',
      'https://other.trychannel3.com/abc',
      'https://shoebacca.com/out?url=https://evil.example',
    ]) {
      const value = snapshot({ productUrl: offerUrl });
      const { service, evidenceRepository } = serviceWith(value);
      const result = await service.prepare({
        intentId: 'intent-1',
        productId: value.productId,
        snapshotId: value.id,
      });
      expect(result.kind).toBe('UNSAFE_URL');
      expect(evidenceRepository.records).toHaveLength(0);
    }
  });

  it('accepts the documented tracking host when allowlisted', async () => {
    const value = snapshot({ productUrl: 'https://buy.trychannel3.com/abc' });
    const { service } = serviceWith(value);
    const result = await service.prepare({
      intentId: 'intent-1',
      productId: value.productId,
      snapshotId: value.id,
    });
    expect(result.kind).toBe('ISSUED');
    if (result.kind === 'ISSUED') expect(result.url).toBe('https://buy.trychannel3.com/abc');
  });

  it('rejects an invalid price or currency snapshot', async () => {
    for (const overrides of [{ price: 0 }, { currency: 'US' }]) {
      const value = {
        ...snapshot(),
        ...overrides,
      };
      const { service, evidenceRepository } = serviceWith(value);
      const result = await service.prepare({
        intentId: 'intent-1',
        productId: value.productId,
        snapshotId: value.id,
      });
      expect(result.kind).toBe('INVALID_SNAPSHOT');
      expect(evidenceRepository.records).toHaveLength(0);
    }
  });

  it('rejects a snapshot older than the established freshness window', async () => {
    const value = snapshot();
    const { service, evidenceRepository } = serviceWith(
      value,
      Date.parse('2026-10-20T12:00:01.000Z'),
    );
    await expect(
      service.prepare({ intentId: 'intent-1', productId: value.productId, snapshotId: value.id }),
    ).resolves.toEqual({ kind: 'STALE' });
    expect(evidenceRepository.records).toHaveLength(0);
  });
});
