import type { FinancialState, PolicyEvaluation, Product, StructuredIntent } from '@agentproof/shared';
import { PolicyEngine } from '../policy/PolicyEngine.js';
import { evidenceIdFor, type EvidenceService } from '../evidence/EvidenceService.js';
import { PayPalClient, PayPalError, type CreatedOrder, type PayPalCaptureResult } from './PayPalClient.js';

export type CreatePaymentOrderResult =
  | { kind: 'ORDER_CREATED'; order: CreatedOrder; evaluation: PolicyEvaluation; confirmationRequired: boolean }
  | { kind: 'CONFIRMATION_REQUIRED'; evaluation: PolicyEvaluation }
  | { kind: 'POLICY_DENIED'; evaluation: PolicyEvaluation };

export interface PaymentServiceDeps {
  policyEngine: PolicyEngine;
  evidence: EvidenceService;
  paypal: PayPalClient;
  /** Trusted owner attached to evidence and used to scope transaction updates. */
  userId?: string | null;
  /**
   * Conditionally persist a transaction financial-state transition. Resolves
   * to `true` when this call won the transition and `false` when it lost a race
   * (the row was no longer PAYMENT_PENDING). A persistence failure rejects.
   */
  persistTransactionState?: (update: {
    transactionId: string;
    financialState: FinancialState;
    paypalCaptureId: string | null;
    updatedAt: string;
    userId?: string | null;
  }) => Promise<boolean>;
}

export type CapturePaymentResult =
  | {
      kind: 'PAYMENT_COMPLETED';
      capture: PayPalCaptureResult;
      reconciled?: boolean;
      /**
       * Set when the verified capture was durably recorded but one or more
       * post-capture evidence writes failed. The payment IS completed; this flag
       * reports the evidence gap so the caller never mistakes an evidence write
       * failure for a failed PayPal capture.
       */
      evidenceIncomplete?: boolean;
      evidenceError?: string;
    }
  | { kind: 'ALREADY_COMPLETED'; financialState: 'PAYMENT_COMPLETED' }
  | { kind: 'INVALID_STATE'; financialState: FinancialState }
  | { kind: 'MISMATCHED_ORDER'; reason: string }
  | { kind: 'INVALID_ORDER_STATE'; orderStatus: string }
  | { kind: 'CAPTURE_UNVERIFIED'; reason: string };

/**
 * PaymentService: PolicyEngine gates first, PayPal executes second.
 * Never decides financial permission via AI. Order creation ≠ capture:
 * this service only ever establishes PAYMENT_PENDING semantics.
 */
export class PaymentService {
  constructor(private readonly deps: PaymentServiceDeps) {}

  private get userId(): string | null {
    return this.deps.userId ?? null;
  }

  async createOrder(params: {
    intentId: string;
    intent: StructuredIntent;
    product: Product;
    confirmationApproved?: boolean;
    returnUrl?: string;
    cancelUrl?: string;
  }): Promise<CreatePaymentOrderResult> {
    const { policyEngine, evidence, paypal } = this.deps;

    // 1. Deterministic policy check — sole authority.
    const evaluation = policyEngine.evaluate(params.intent, params.product);
    evaluation.intentId = params.intentId;

    await evidence.record(
      {
        eventType: 'POLICY_EVALUATED',
        actor: 'policy_engine',
        source: 'policy_engine',
        intentId: params.intentId,
        policyEvaluationId: evaluation.id,
        data: {
          productId: params.product.id,
          result: evaluation.result,
          confirmationRequired: evaluation.confirmationRequired,
          ruleResults: evaluation.ruleResults,
          phase: 'pre_paypal_order',
        },
      },
      this.userId,
    );

    if (evaluation.result === 'DENY') {
      return { kind: 'POLICY_DENIED', evaluation };
    }

    // 2. Confirmation gate.
    if (evaluation.confirmationRequired && params.confirmationApproved !== true) {
      return { kind: 'CONFIRMATION_REQUIRED', evaluation };
    }

    // 3. Real PayPal Sandbox order creation.
    const order = await paypal.createOrder({
      amount: params.product.price,
      currency: params.product.currency,
      description: params.product.name,
      invoiceId: `${params.intentId}-${params.product.id}`.slice(0, 127),
      returnUrl: params.returnUrl,
      cancelUrl: params.cancelUrl,
    });

    await evidence.record(
      {
        eventType: 'PAYPAL_ORDER_CREATED',
        actor: 'paypal',
        source: 'paypal_api',
        intentId: params.intentId,
        policyEvaluationId: evaluation.id,
        data: {
          paypalOrderId: order.id,
          paypalStatus: order.status,
          productId: params.product.id,
          amount: params.product.price,
          currency: params.product.currency,
        },
      },
      this.userId,
    );

    return { kind: 'ORDER_CREATED', order, evaluation, confirmationRequired: evaluation.confirmationRequired };
  }

  /**
   * Capture an already buyer-approved PayPal order for an existing
   * PAYMENT_PENDING transaction. Never touches PAYMENT_COMPLETED semantics
   * without a verified PayPal capture response.
   */
  async captureApprovedOrder(params: {
    transactionId: string;
    intentId: string;
    productId: string;
    paypalOrderId: string;
    expectedAmount: number;
    expectedCurrency: string;
    financialState: FinancialState;
    policyEvaluationId?: string | null;
  }): Promise<CapturePaymentResult> {
    const { evidence, paypal, persistTransactionState } = this.deps;
    const now = () => new Date().toISOString();

    /**
     * Record post-capture evidence without ever allowing an evidence-write
     * failure to be read as a failed PayPal capture. The transaction has already
     * been durably transitioned at this point, so a failure here is reported as
     * `evidenceIncomplete` on an otherwise-successful completion.
     * P2-C: use deterministic IDs per (transactionId, eventType) and idempotent
     * writes to support recovery without duplicate events.
     */
    const recordCompletionEvidence = async (
      events: Array<Parameters<EvidenceService['record']>[0]>,
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        for (const event of events) {
          const txId = event.transactionId ?? params.transactionId;
          if (!txId) {
            await evidence.record(event, this.userId);
            continue;
          }
          // Deterministic id + atomic insert-if-absent: retries and concurrent
          // writers converge on one record and a duplicate conflict is success.
          await evidence.recordIdempotent(
            {
              ...event,
              transactionId: txId,
              id: evidenceIdFor(txId, event.eventType),
            },
            this.userId,
          );
        }
        return { ok: true };
      } catch (err) {
        // Keep the diagnostic internal; routes expose only a stable status.
        const message = err instanceof Error ? err.message : 'Evidence write failed';
        return { ok: false, error: message };
      }
    };

    // Idempotency: never capture twice.
    if (params.financialState === 'PAYMENT_COMPLETED') {
      return { kind: 'ALREADY_COMPLETED', financialState: 'PAYMENT_COMPLETED' };
    }
    if (params.financialState !== 'PAYMENT_PENDING') {
      return { kind: 'INVALID_STATE', financialState: params.financialState };
    }

    // Retrieve the real PayPal order and verify it matches the transaction.
    const order = await paypal.getOrder(params.paypalOrderId);

    const expectedInvoiceId = `${params.intentId}-${params.productId}`.slice(0, 127);
    const orderMatches =
      order.id === params.paypalOrderId &&
      order.invoiceId === expectedInvoiceId &&
      order.amount !== null &&
      Math.abs(order.amount - params.expectedAmount) < 0.005 &&
      order.currency === params.expectedCurrency;

    if (!orderMatches) {
      await evidence.record(
        {
          eventType: 'PAYPAL_ORDER_APPROVAL_VERIFIED',
          actor: 'paypal',
          source: 'paypal_api',
          intentId: params.intentId,
          transactionId: params.transactionId,
          policyEvaluationId: params.policyEvaluationId ?? undefined,
          data: {
            passed: false,
            reason: 'ORDER_MISMATCH',
            paypalOrderId: order.id,
            paypalStatus: order.status,
            expectedInvoiceId,
          },
        },
        this.userId,
      );
      return { kind: 'MISMATCHED_ORDER', reason: 'PayPal order does not match transaction' };
    }

    await evidence.record(
      {
        eventType: 'PAYPAL_ORDER_APPROVAL_VERIFIED',
        actor: 'paypal',
        source: 'paypal_api',
        intentId: params.intentId,
        transactionId: params.transactionId,
        policyEvaluationId: params.policyEvaluationId ?? undefined,
        data: {
          passed: true,
          paypalOrderId: order.id,
          paypalStatus: order.status,
          amount: order.amount,
          currency: order.currency,
        },
      },
      this.userId,
    );

    // Reconcile: PayPal already captured but local state lagged.
    if (order.status === 'COMPLETED') {
      const persisted = await persistTransactionState?.({
        transactionId: params.transactionId,
        financialState: 'PAYMENT_COMPLETED',
        paypalCaptureId: null,
        updatedAt: now(),
        userId: this.userId,
      });
      if (persisted === false) {
        return { kind: 'ALREADY_COMPLETED', financialState: 'PAYMENT_COMPLETED' };
      }
      const reconciledEvidence = await recordCompletionEvidence([
        {
          eventType: 'PAYMENT_COMPLETED',
          actor: 'agent',
          source: 'paypal_api',
          intentId: params.intentId,
          transactionId: params.transactionId,
          policyEvaluationId: params.policyEvaluationId ?? undefined,
          data: { reason: 'reconciled_from_paypal_completed_order', paypalOrderId: order.id },
        },
      ]);
      return {
        kind: 'PAYMENT_COMPLETED',
        reconciled: true,
        ...(reconciledEvidence.ok
          ? {}
          : { evidenceIncomplete: true, evidenceError: reconciledEvidence.error }),
        capture: {
          orderId: order.id,
          orderStatus: order.status,
          captureId: null,
          captureStatus: 'COMPLETED',
          amount: order.amount,
          currency: order.currency,
        },
      };
    }

    if (order.status !== 'APPROVED') {
      // e.g. CREATED (buyer has not approved), VOIDED, etc.
      return { kind: 'INVALID_ORDER_STATE', orderStatus: order.status };
    }

    // Capture through the real PayPal Sandbox.
    let capture: PayPalCaptureResult;
    try {
      capture = await paypal.captureOrder(params.paypalOrderId);
    } catch (err) {
      if (err instanceof PayPalError && err.status === 422 && /already.?captured/i.test(err.message)) {
        const persisted = await persistTransactionState?.({
          transactionId: params.transactionId,
          financialState: 'PAYMENT_COMPLETED',
          paypalCaptureId: null,
          updatedAt: now(),
          userId: this.userId,
        });
        if (persisted === false) {
          return { kind: 'ALREADY_COMPLETED', financialState: 'PAYMENT_COMPLETED' };
        }
        const reconciledEvidence = await recordCompletionEvidence([
          {
            eventType: 'PAYMENT_COMPLETED',
            actor: 'agent',
            source: 'paypal_api',
            intentId: params.intentId,
            transactionId: params.transactionId,
            policyEvaluationId: params.policyEvaluationId ?? undefined,
            data: { reason: 'reconciled_order_already_captured', paypalOrderId: params.paypalOrderId },
          },
        ]);
        return {
          kind: 'PAYMENT_COMPLETED',
          reconciled: true,
          ...(reconciledEvidence.ok
            ? {}
            : { evidenceIncomplete: true, evidenceError: reconciledEvidence.error }),
          capture: {
            orderId: params.paypalOrderId,
            orderStatus: 'COMPLETED',
            captureId: null,
            captureStatus: 'COMPLETED',
            amount: params.expectedAmount,
            currency: params.expectedCurrency,
          },
        };
      }
      throw err;
    }

    const captureVerified =
      capture.orderStatus === 'COMPLETED' &&
      capture.captureStatus === 'COMPLETED' &&
      capture.amount !== null &&
      Math.abs(capture.amount - params.expectedAmount) < 0.005 &&
      capture.currency === params.expectedCurrency;

    if (!captureVerified) {
      return {
        kind: 'CAPTURE_UNVERIFIED',
        reason: `PayPal capture not verified: status=${capture.orderStatus}/${capture.captureStatus} amount=${capture.amount} ${capture.currency}`,
      };
    }

    // Durably record the verified capture BEFORE writing post-capture evidence.
    // The transaction row is the durable recovery record: once it is COMPLETED,
    // a retry returns ALREADY_COMPLETED and never issues a second PayPal capture,
    // even if a subsequent evidence write fails.
    const persisted = await persistTransactionState?.({
      transactionId: params.transactionId,
      financialState: 'PAYMENT_COMPLETED',
      paypalCaptureId: capture.captureId,
      updatedAt: now(),
      userId: this.userId,
    });
    if (persisted === false) {
      // Lost the pending→completed race: another request already completed this
      // transaction, so emit no duplicate completion evidence.
      return { kind: 'ALREADY_COMPLETED', financialState: 'PAYMENT_COMPLETED' };
    }

    const completionEvidence = await recordCompletionEvidence([
      {
        eventType: 'PAYPAL_PAYMENT_CAPTURED',
        actor: 'paypal',
        source: 'paypal_api',
        intentId: params.intentId,
        transactionId: params.transactionId,
        policyEvaluationId: params.policyEvaluationId ?? undefined,
        data: {
          paypalOrderId: capture.orderId,
          paypalCaptureId: capture.captureId,
          paypalStatus: capture.captureStatus,
          amount: capture.amount,
          currency: capture.currency,
        },
      },
      {
        eventType: 'PAYMENT_CAPTURED',
        actor: 'paypal',
        source: 'paypal_api',
        intentId: params.intentId,
        transactionId: params.transactionId,
        policyEvaluationId: params.policyEvaluationId ?? undefined,
        data: {
          paypalOrderId: capture.orderId,
          paypalCaptureId: capture.captureId,
          amount: capture.amount,
          currency: capture.currency,
        },
      },
      {
        eventType: 'PAYMENT_COMPLETED',
        actor: 'agent',
        source: 'paypal_api',
        intentId: params.intentId,
        transactionId: params.transactionId,
        policyEvaluationId: params.policyEvaluationId ?? undefined,
        data: {
          paypalOrderId: capture.orderId,
          paypalCaptureId: capture.captureId,
          amount: capture.amount,
          currency: capture.currency,
        },
      },
    ]);

    return {
      kind: 'PAYMENT_COMPLETED',
      capture,
      ...(completionEvidence.ok
        ? {}
        : { evidenceIncomplete: true, evidenceError: completionEvidence.error }),
    };
  }
}
