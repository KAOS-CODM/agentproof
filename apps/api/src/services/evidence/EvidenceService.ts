import type { EvidenceRecord } from '@agentproof/shared';
import { generateId } from '../../utils/id.js';
import type { EvidenceRepository } from './EvidenceRepository.js';

export type EvidenceEventType =
  | 'INTENT_CREATED'
  | 'INTENT_PARSED'
  | 'INTENT_VALIDATED'
  | 'POLICY_EVALUATED'
  | 'PRODUCT_CONSIDERED'
  | 'PRODUCT_SELECTED'
  | 'PAYPAL_ORDER_CREATED'
  | 'PAYMENT_CAPTURED'
  | 'FULFILLMENT_RECORDED'
  | 'DELIVERY_RECORDED'
  | 'DISPUTE_OPENED'
  | 'EVIDENCE_RETRIEVED'
  | 'DECISION_GENERATED'
  | 'APPROVAL_REQUESTED'
  | 'APPROVAL_GRANTED'
  | 'APPROVAL_DENIED'
  | 'CONSEQUENTIAL_ACTION_EXECUTED';

export type EvidenceSource =
  | 'user_input'
  | 'openrouter'
  | 'policy_engine'
  | 'paypal_api'
  | 'demo_fulfillment'
  | 'human_approval'
  | 'agent';

export interface CreateEvidenceParams {
  eventType: EvidenceEventType;
  actor: EvidenceRecord['actor'];
  source: EvidenceSource;
  transactionId?: string;
  intentId?: string;
  approvalRequestId?: string;
  policyEvaluationId?: string;
  data: Record<string, unknown>;
  correlationId?: string;
}

export class EvidenceService {
  private repository: EvidenceRepository;

  constructor(repository: EvidenceRepository) {
    this.repository = repository;
  }

  record(params: CreateEvidenceParams): EvidenceRecord {
    const record: EvidenceRecord = {
      id: generateId(),
      eventType: params.eventType,
      timestamp: new Date().toISOString(),
      actor: params.actor,
      transactionId: params.transactionId ?? null,
      intentId: params.intentId ?? null,
      approvalRequestId: params.approvalRequestId ?? null,
      policyEvaluationId: params.policyEvaluationId ?? null,
      data: params.data,
      metadata: {
        source: params.source,
        correlationId: params.correlationId ?? generateId(),
      },
    };

    this.repository.append(record);
    return record;
  }

  getById(id: string): EvidenceRecord | null {
    return this.repository.getById(id);
  }

  getByIntentId(intentId: string): EvidenceRecord[] {
    return this.repository.getByIntentId(intentId);
  }

  getByTransactionId(transactionId: string): EvidenceRecord[] {
    return this.repository.getByTransactionId(transactionId);
  }

  getAll(): EvidenceRecord[] {
    return this.repository.getAll();
  }
}
