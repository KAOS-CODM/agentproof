import { describe, it, expect, beforeEach } from 'vitest';
import initSqlJs from 'sql.js';
import { EvidenceService } from './EvidenceService.js';
import { SQLiteEvidenceRepository } from './SQLiteEvidenceRepository.js';

describe('EvidenceService', () => {
  let db: InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']>;
  let service: EvidenceService;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.exec(`
      CREATE TABLE evidence_records (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        actor TEXT NOT NULL,
        transaction_id TEXT,
        intent_id TEXT,
        approval_request_id TEXT,
        policy_evaluation_id TEXT,
        data_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );
    `);
    service = new EvidenceService(new SQLiteEvidenceRepository(db));
  });

  it('appends a record', () => {
    const record = service.record({
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

  it('retrieves a record by ID', () => {
    const record = service.record({
      eventType: 'POLICY_EVALUATED',
      actor: 'policy_engine',
      source: 'policy_engine',
      intentId: 'intent-1',
      data: { result: 'ALLOW' },
    });

    const retrieved = service.getById(record.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(record.id);
    expect(retrieved!.eventType).toBe('POLICY_EVALUATED');
  });

  it('retrieves records by intent ID', () => {
    service.record({
      eventType: 'INTENT_CREATED',
      actor: 'user',
      source: 'user_input',
      intentId: 'intent-1',
      data: {},
    });
    service.record({
      eventType: 'POLICY_EVALUATED',
      actor: 'policy_engine',
      source: 'policy_engine',
      intentId: 'intent-1',
      data: {},
    });
    service.record({
      eventType: 'INTENT_CREATED',
      actor: 'user',
      source: 'user_input',
      intentId: 'intent-2',
      data: {},
    });

    const records = service.getByIntentId('intent-1');
    expect(records).toHaveLength(2);
  });

  it('retrieves records by transaction ID', () => {
    service.record({
      eventType: 'PAYMENT_CAPTURED',
      actor: 'paypal',
      source: 'paypal_api',
      transactionId: 'tx-1',
      data: {},
    });
    service.record({
      eventType: 'DELIVERY_RECORDED',
      actor: 'agent',
      source: 'demo_fulfillment',
      transactionId: 'tx-1',
      data: {},
    });

    const records = service.getByTransactionId('tx-1');
    expect(records).toHaveLength(2);
  });

  it('preserves provenance metadata', () => {
    const record = service.record({
      eventType: 'DELIVERY_RECORDED',
      actor: 'agent',
      source: 'demo_fulfillment',
      transactionId: 'tx-1',
      data: { carrier: 'UPS' },
    });

    expect(record.metadata.source).toBe('demo_fulfillment');
    expect(record.metadata.correlationId).toBeDefined();

    const retrieved = service.getById(record.id);
    expect(retrieved!.metadata.source).toBe('demo_fulfillment');
  });

  it('generates unique correlation IDs when not provided', () => {
    const r1 = service.record({
      eventType: 'INTENT_CREATED',
      actor: 'user',
      source: 'user_input',
      data: {},
    });
    const r2 = service.record({
      eventType: 'INTENT_CREATED',
      actor: 'user',
      source: 'user_input',
      data: {},
    });

    expect(r1.metadata.correlationId).not.toBe(r2.metadata.correlationId);
  });

  it('uses provided correlation ID when given', () => {
    const record = service.record({
      eventType: 'INTENT_CREATED',
      actor: 'user',
      source: 'user_input',
      data: {},
      correlationId: 'corr-123',
    });

    expect(record.metadata.correlationId).toBe('corr-123');
  });

  it('returns null for non-existent record', () => {
    const result = service.getById('non-existent');
    expect(result).toBeNull();
  });

  it('returns all records', () => {
    service.record({
      eventType: 'INTENT_CREATED',
      actor: 'user',
      source: 'user_input',
      data: {},
    });
    service.record({
      eventType: 'POLICY_EVALUATED',
      actor: 'policy_engine',
      source: 'policy_engine',
      data: {},
    });

    const all = service.getAll();
    expect(all).toHaveLength(2);
  });

  it('is append-only (no update or delete methods)', () => {
    // Verify the interface doesn't expose update/delete
    const record = service.record({
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
  });
});
