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
  | 'RETAILER_HANDOFF_PREPARED'
  | 'PAYPAL_ORDER_CREATED'
  | 'PAYPAL_ORDER_APPROVAL_VERIFIED'
  | 'PAYPAL_PAYMENT_CAPTURED'
  | 'PAYMENT_CAPTURED'
  | 'PAYMENT_COMPLETED'
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
  | 'agent'
  | 'demo_catalog'
  | 'channel3';

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

/** Deterministic evidence ID for recovery/idempotent post-capture events. */
export function evidenceIdFor(transactionId: string, eventType: EvidenceEventType): string {
  return `ev:${transactionId}:${eventType}`;
}

export class EvidenceService {
  private repository: EvidenceRepository;

  constructor(repository: EvidenceRepository) {
    this.repository = repository;
  }

  /**
   * Append evidence owned by `userId`. Routes always pass the authenticated
   * server-side user id; it is never accepted from a request body.
   */
  async record(params: CreateEvidenceParams, userId?: string | null): Promise<EvidenceRecord> {
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

    // Append-only: a failed write must propagate to the caller rather than be
    // silently swallowed (no fire-and-forget evidence).
    await this.repository.append(record, userId);
    return record;
  }

  async recordIdempotent(
    params: CreateEvidenceParams & { id?: string },
    userId?: string | null,
  ): Promise<{ record: EvidenceRecord; created: boolean }> {
    const id = params.id ?? generateId();
    const record: EvidenceRecord = {
      id,
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

    // Atomic insert-if-absent: the backend's uniqueness constraint decides the
    // winner, so concurrent writers of the same deterministic id cannot create
    // duplicates. A genuine conflict is an idempotent success.
    const outcome = await this.repository.appendIfAbsent(record, userId);
    if (outcome === 'created') {
      return { record, created: true };
    }

    // Re-read using the same ownership scope as the write. A conflict caused by
    // another owner's record must fail closed rather than leak that record.
    const existing = userId
      ? await this.repository.getByIdForUser(id, userId)
      : await this.repository.getById(id);
    if (existing) {
      return { record: existing, created: false };
    }
    // The backend reported a conflict but the record is not readable; fail
    // closed instead of pretending the write succeeded.
    throw new Error(`Evidence ${id} conflicted but could not be read back`);
  }

  async exists(id: string): Promise<boolean> {
    if (typeof (this.repository as EvidenceRepository).exists === 'function') {
      return (this.repository as EvidenceRepository).exists!(id);
    }
    const record = await this.repository.getById(id);
    return record !== null;
  }

  async getById(id: string): Promise<EvidenceRecord | null> {
    return this.repository.getById(id);
  }

  async getByIdForUser(id: string, userId: string): Promise<EvidenceRecord | null> {
    return this.repository.getByIdForUser(id, userId);
  }

  async getByIntentId(intentId: string): Promise<EvidenceRecord[]> {
    return this.repository.getByIntentId(intentId);
  }

  async getByIntentIdForUser(intentId: string, userId: string): Promise<EvidenceRecord[]> {
    return this.repository.getByIntentIdForUser(intentId, userId);
  }

  async getByTransactionId(transactionId: string): Promise<EvidenceRecord[]> {
    return this.repository.getByTransactionId(transactionId);
  }

  async getByTransactionIdForUser(
    transactionId: string,
    userId: string,
  ): Promise<EvidenceRecord[]> {
    return this.repository.getByTransactionIdForUser(transactionId, userId);
  }

  async getAll(): Promise<EvidenceRecord[]> {
    return this.repository.getAll();
  }

  async getAllForUser(userId: string): Promise<EvidenceRecord[]> {
    return this.repository.getAllForUser(userId);
  }

  /**
   * P2-C recovery: ensure the completion evidence that is *supported by
   * persisted transaction/capture data* exists for an already-completed
   * transaction. It never captures, never transitions state, and is safe to
   * retry because every write uses the deterministic `(transactionId,
   * eventType)` id.
   *
   * Bounded by construction: it only considers the three post-capture events
   * below and returns without writing anything when the persisted PayPal order
   * id is missing, so it cannot invent a capture or a completion. Failures are
   * reported in `failed` rather than thrown; nothing here is exposed to clients.
   */
  async recoverCompletionEvidence(params: {
    transactionId: string;
    intentId: string;
    orderId: string;
    /** Trusted owner; recovery must never recreate evidence for another user. */
    userId?: string | null;
    policyEvaluationId?: string | null;
    captureId?: string | null;
    amount?: number;
    currency?: string;
    reason?: string;
  }): Promise<{
    recovered: EvidenceEventType[];
    existing: EvidenceEventType[];
    failed: EvidenceEventType[];
  }> {
    const recovered: EvidenceEventType[] = [];
    const existing: EvidenceEventType[] = [];
    const failed: EvidenceEventType[] = [];

    // Fail closed: without persisted order information there is nothing
    // trustworthy to reconstruct.
    if (!params.transactionId || !params.orderId) {
      return { recovered, existing, failed };
    }

    const ensure = async (
      eventType: EvidenceEventType,
      data: Record<string, unknown>,
      actor: EvidenceRecord['actor'],
      source: EvidenceSource,
    ) => {
      try {
        const { created } = await this.recordIdempotent(
          {
            id: evidenceIdFor(params.transactionId, eventType),
            eventType,
            actor,
            source,
            transactionId: params.transactionId,
            intentId: params.intentId,
            policyEvaluationId: params.policyEvaluationId ?? undefined,
            data,
          },
          params.userId,
        );
        (created ? recovered : existing).push(eventType);
      } catch {
        failed.push(eventType);
      }
    };

    if (params.captureId) {
      await ensure(
        'PAYPAL_PAYMENT_CAPTURED',
        {
          paypalOrderId: params.orderId,
          paypalCaptureId: params.captureId,
          amount: params.amount,
          currency: params.currency,
        },
        'paypal',
        'paypal_api',
      );
      await ensure(
        'PAYMENT_CAPTURED',
        {
          paypalOrderId: params.orderId,
          paypalCaptureId: params.captureId,
          amount: params.amount,
          currency: params.currency,
        },
        'paypal',
        'paypal_api',
      );
    }
    await ensure(
      'PAYMENT_COMPLETED',
      {
        paypalOrderId: params.orderId,
        paypalCaptureId: params.captureId,
        amount: params.amount,
        currency: params.currency,
        reason: params.reason,
      },
      'agent',
      'paypal_api',
    );

    return { recovered, existing, failed };
  }
}
