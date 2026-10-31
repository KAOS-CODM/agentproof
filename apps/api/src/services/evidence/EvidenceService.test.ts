import { describe, it, expect, beforeEach } from 'vitest';
import type { EvidenceRecord } from '@agentproof/shared';
import { EvidenceService, evidenceIdFor } from './EvidenceService.js';
import { InMemoryEvidenceRepository } from '../../test/inMemoryRepositories.js';

function deterministicRecord(id: string, overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    id,
    eventType: 'PAYMENT_COMPLETED',
    timestamp: '2026-10-20T10:00:00.000Z',
    actor: 'agent',
    transactionId: 'tx-1',
    intentId: 'intent-1',
    approvalRequestId: null,
    policyEvaluationId: 'pe-1',
    data: { paypalOrderId: 'O-1' },
    metadata: { source: 'paypal_api', correlationId: 'c-1' },
    ...overrides,
  };
}

describe('EvidenceService', () => {
  let repo: InMemoryEvidenceRepository;
  let service: EvidenceService;

  beforeEach(() => {
    repo = new InMemoryEvidenceRepository();
    service = new EvidenceService(repo);
  });

  it('appends a record', async () => {
    const record = await service.record({
      eventType: 'INTENT_CREATED',
      actor: 'user',
      source: 'user_input',
      intentId: 'intent-1',
      data: { rawInput: 'Buy running shoes' },
    });

    expect(record.id).toBeDefined();
    expect(record.eventType).toBe('INTENT_CREATED');
    expect(record.actor).toBe('user');
    expect(record.metadata.source).toBe('user_input');
  });

  it('retrieves a record by ID', async () => {
    const record = await service.record({
      eventType: 'POLICY_EVALUATED',
      actor: 'policy_engine',
      source: 'policy_engine',
      intentId: 'intent-1',
      data: { result: 'ALLOW' },
    });

    const retrieved = await service.getById(record.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(record.id);
    expect(retrieved!.eventType).toBe('POLICY_EVALUATED');
  });

  it('retrieves records by intent ID', async () => {
    await service.record({
      eventType: 'INTENT_CREATED',
      actor: 'user',
      source: 'user_input',
      intentId: 'intent-1',
      data: {},
    });
    await service.record({
      eventType: 'POLICY_EVALUATED',
      actor: 'policy_engine',
      source: 'policy_engine',
      intentId: 'intent-1',
      data: {},
    });
    await service.record({
      eventType: 'INTENT_CREATED',
      actor: 'user',
      source: 'user_input',
      intentId: 'intent-2',
      data: {},
    });

    const records = await service.getByIntentId('intent-1');
    expect(records).toHaveLength(2);
  });

  it('retrieves records by transaction ID', async () => {
    await service.record({
      eventType: 'PAYMENT_CAPTURED',
      actor: 'paypal',
      source: 'paypal_api',
      transactionId: 'tx-1',
      data: {},
    });
    await service.record({
      eventType: 'DELIVERY_RECORDED',
      actor: 'agent',
      source: 'demo_fulfillment',
      transactionId: 'tx-1',
      data: {},
    });

    const records = await service.getByTransactionId('tx-1');
    expect(records).toHaveLength(2);
  });

  it('preserves provenance metadata', async () => {
    const record = await service.record({
      eventType: 'DELIVERY_RECORDED',
      actor: 'agent',
      source: 'demo_fulfillment',
      transactionId: 'tx-1',
      data: { carrier: 'UPS' },
    });

    expect(record.metadata.source).toBe('demo_fulfillment');
    expect(record.metadata.correlationId).toBeDefined();

    const retrieved = await service.getById(record.id);
    expect(retrieved!.metadata.source).toBe('demo_fulfillment');
  });

  it('generates unique correlation IDs when not provided', async () => {
    const r1 = await service.record({
      eventType: 'INTENT_CREATED',
      actor: 'user',
      source: 'user_input',
      data: {},
    });
    const r2 = await service.record({
      eventType: 'INTENT_CREATED',
      actor: 'user',
      source: 'user_input',
      data: {},
    });

    expect(r1.metadata.correlationId).not.toBe(r2.metadata.correlationId);
  });

  it('uses provided correlation ID when given', async () => {
    const record = await service.record({
      eventType: 'INTENT_CREATED',
      actor: 'user',
      source: 'user_input',
      data: {},
      correlationId: 'corr-123',
    });

    expect(record.metadata.correlationId).toBe('corr-123');
  });

  it('returns null for non-existent record', async () => {
    const result = await service.getById('non-existent');
    expect(result).toBeNull();
  });

  it('returns all records', async () => {
    await service.record({
      eventType: 'INTENT_CREATED',
      actor: 'user',
      source: 'user_input',
      data: {},
    });
    await service.record({
      eventType: 'POLICY_EVALUATED',
      actor: 'policy_engine',
      source: 'policy_engine',
      data: {},
    });

    const all = await service.getAll();
    expect(all).toHaveLength(2);
  });

  it('propagates a repository append failure instead of swallowing it', async () => {
    const failing = new InMemoryEvidenceRepository();
    failing.append = async () => {
      throw new Error('evidence write failed');
    };
    const failingService = new EvidenceService(failing);

    await expect(
      failingService.record({
        eventType: 'INTENT_CREATED',
        actor: 'user',
        source: 'user_input',
        data: {},
      }),
    ).rejects.toThrow('evidence write failed');
  });

  describe('deterministic idempotent writes', () => {
    it('builds stable IDs per transaction and event type, distinct across both', () => {
      expect(evidenceIdFor('tx-1', 'PAYMENT_COMPLETED')).toBe('ev:tx-1:PAYMENT_COMPLETED');
      expect(evidenceIdFor('tx-1', 'PAYMENT_COMPLETED')).toBe(
        evidenceIdFor('tx-1', 'PAYMENT_COMPLETED'),
      );
      expect(evidenceIdFor('tx-1', 'PAYMENT_CAPTURED')).not.toBe(
        evidenceIdFor('tx-1', 'PAYMENT_COMPLETED'),
      );
      expect(evidenceIdFor('tx-2', 'PAYMENT_COMPLETED')).not.toBe(
        evidenceIdFor('tx-1', 'PAYMENT_COMPLETED'),
      );
    });

    it('keeps normal record() identifiers independent of deterministic IDs', async () => {
      const normal = await service.record({
        eventType: 'PAYMENT_COMPLETED',
        actor: 'agent',
        source: 'paypal_api',
        transactionId: 'tx-1',
        data: {},
      });

      expect(normal.id).not.toBe(evidenceIdFor('tx-1', 'PAYMENT_COMPLETED'));
      expect(normal.id).toMatch(/[0-9a-f-]{8,}/i);
    });

    it('repeated writes of the same deterministic ID create exactly one record', async () => {
      const id = evidenceIdFor('tx-1', 'PAYMENT_COMPLETED');
      const params = {
        id,
        eventType: 'PAYMENT_COMPLETED' as const,
        actor: 'agent' as const,
        source: 'paypal_api' as const,
        transactionId: 'tx-1',
        intentId: 'intent-1',
        data: { paypalOrderId: 'O-1' },
      };

      const first = await service.recordIdempotent(params);
      const second = await service.recordIdempotent({ ...params, data: { paypalOrderId: 'O-2' } });

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.record.id).toBe(id);
      // The original record is preserved; the retry does not overwrite it.
      expect(second.record.data).toEqual({ paypalOrderId: 'O-1' });
      expect(await service.getByTransactionId('tx-1')).toHaveLength(1);
    });

    it('concurrent writes of the same deterministic ID do not duplicate evidence', async () => {
      const id = evidenceIdFor('tx-1', 'PAYMENT_CAPTURED');
      const params = {
        id,
        eventType: 'PAYMENT_CAPTURED' as const,
        actor: 'paypal' as const,
        source: 'paypal_api' as const,
        transactionId: 'tx-1',
        intentId: 'intent-1',
        data: {},
      };

      const results = await Promise.all([
        service.recordIdempotent(params),
        service.recordIdempotent(params),
        service.recordIdempotent(params),
      ]);

      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(await service.getByTransactionId('tx-1')).toHaveLength(1);
    });

    it('treats a backend duplicate-key conflict as an idempotent success', async () => {
      const existing = deterministicRecord('ev:tx-1:PAYMENT_COMPLETED');
      await repo.append(existing);
      // Simulate the backend reporting the uniqueness conflict directly.
      repo.appendIfAbsent = async () => 'exists';

      const result = await service.recordIdempotent({
        id: existing.id,
        eventType: 'PAYMENT_COMPLETED',
        actor: 'agent',
        source: 'paypal_api',
        transactionId: 'tx-1',
        intentId: 'intent-1',
        data: { paypalOrderId: 'O-2' },
      });

      expect(result.created).toBe(false);
      expect(result.record).toEqual(existing);
      expect(await service.getByTransactionId('tx-1')).toHaveLength(1);
    });

    it('propagates unrelated repository errors instead of classifying them as duplicates', async () => {
      const failing = new InMemoryEvidenceRepository();
      failing.appendIfAbsent = async () => {
        throw new Error('database offline');
      };
      const failingService = new EvidenceService(failing);

      await expect(
        failingService.recordIdempotent({
          id: 'ev:tx-1:PAYMENT_COMPLETED',
          eventType: 'PAYMENT_COMPLETED',
          actor: 'agent',
          source: 'paypal_api',
          transactionId: 'tx-1',
          data: {},
        }),
      ).rejects.toThrow('database offline');
    });

    it('fails closed when a conflict is reported but the record is unreadable', async () => {
      const inconsistent = new InMemoryEvidenceRepository();
      inconsistent.appendIfAbsent = async () => 'exists';
      const inconsistentService = new EvidenceService(inconsistent);

      await expect(
        inconsistentService.recordIdempotent({
          id: 'ev:tx-1:PAYMENT_COMPLETED',
          eventType: 'PAYMENT_COMPLETED',
          actor: 'agent',
          source: 'paypal_api',
          transactionId: 'tx-1',
          data: {},
        }),
      ).rejects.toThrow('could not be read back');
    });
  });

  describe('recoverCompletionEvidence', () => {
    const recoveryParams = {
      transactionId: 'tx-1',
      intentId: 'intent-1',
      orderId: 'O-1',
      policyEvaluationId: 'pe-1',
      captureId: 'CAP-1',
      amount: 99,
      currency: 'USD',
    };

    it('creates only the missing completion events', async () => {
      // The capture event already landed before the failure.
      await service.recordIdempotent({
        id: evidenceIdFor('tx-1', 'PAYPAL_PAYMENT_CAPTURED'),
        eventType: 'PAYPAL_PAYMENT_CAPTURED',
        actor: 'paypal',
        source: 'paypal_api',
        transactionId: 'tx-1',
        intentId: 'intent-1',
        data: { paypalCaptureId: 'CAP-1' },
      });

      const outcome = await service.recoverCompletionEvidence(recoveryParams);

      expect(outcome.existing).toContain('PAYPAL_PAYMENT_CAPTURED');
      expect(outcome.recovered).toEqual(
        expect.arrayContaining(['PAYMENT_CAPTURED', 'PAYMENT_COMPLETED']),
      );
      expect(outcome.failed).toEqual([]);

      const events = (await service.getByTransactionId('tx-1')).map((r) => r.eventType);
      expect(events.filter((e) => e === 'PAYPAL_PAYMENT_CAPTURED')).toHaveLength(1);
      expect(events.filter((e) => e === 'PAYMENT_CAPTURED')).toHaveLength(1);
      expect(events.filter((e) => e === 'PAYMENT_COMPLETED')).toHaveLength(1);
    });

    it('is safe to retry: a second run recovers nothing and duplicates nothing', async () => {
      const first = await service.recoverCompletionEvidence(recoveryParams);
      expect(first.recovered).toHaveLength(3);

      const second = await service.recoverCompletionEvidence(recoveryParams);
      expect(second.recovered).toEqual([]);
      expect(second.existing).toHaveLength(3);
      expect(second.failed).toEqual([]);
      expect(await service.getByTransactionId('tx-1')).toHaveLength(3);
    });

    it('does not invent capture events when no capture id is persisted (reconciled case)', async () => {
      const outcome = await service.recoverCompletionEvidence({
        ...recoveryParams,
        captureId: null,
      });

      expect(outcome.recovered).toEqual(['PAYMENT_COMPLETED']);
      const events = (await service.getByTransactionId('tx-1')).map((r) => r.eventType);
      expect(events).not.toContain('PAYPAL_PAYMENT_CAPTURED');
      expect(events).not.toContain('PAYMENT_CAPTURED');
    });

    it('writes nothing when the persisted PayPal order id is absent', async () => {
      const outcome = await service.recoverCompletionEvidence({
        ...recoveryParams,
        orderId: '',
      });

      expect(outcome).toEqual({ recovered: [], existing: [], failed: [] });
      expect(await service.getByTransactionId('tx-1')).toEqual([]);
    });

    it('reports failed events without throwing, then succeeds on retry', async () => {
      const flaky = new InMemoryEvidenceRepository();
      const flakyService = new EvidenceService(flaky);
      const original = flaky.appendIfAbsent.bind(flaky);
      flaky.appendIfAbsent = async (record) => {
        if (record.eventType === 'PAYMENT_CAPTURED') throw new Error('write unavailable');
        return original(record);
      };

      const first = await flakyService.recoverCompletionEvidence(recoveryParams);
      expect(first.failed).toEqual(['PAYMENT_CAPTURED']);
      expect(first.recovered).toContain('PAYMENT_COMPLETED');

      flaky.appendIfAbsent = original;
      const retry = await flakyService.recoverCompletionEvidence(recoveryParams);
      expect(retry.failed).toEqual([]);
      expect(retry.recovered).toEqual(['PAYMENT_CAPTURED']);
      expect(await flakyService.getByTransactionId('tx-1')).toHaveLength(3);
    });
  });

  it('is append-only (no update or delete methods)', async () => {
    // Verify the interface doesn't expose update/delete
    const record = await service.record({
      eventType: 'INTENT_CREATED',
      actor: 'user',
      source: 'user_input',
      data: {},
    });

    // The service should only have record, getById, getByIntentId, getByTransactionId, getAll
    expect(typeof service.record).toBe('function');
    expect(typeof service.getById).toBe('function');
    expect(typeof service.getByIntentId).toBe('function');
    expect(typeof service.getByTransactionId).toBe('function');
    expect(typeof service.getAll).toBe('function');

    // No update or delete
    expect((service as any).update).toBeUndefined();
    expect((service as any).delete).toBeUndefined();
    expect(record.id).toBeDefined();
  });
});
