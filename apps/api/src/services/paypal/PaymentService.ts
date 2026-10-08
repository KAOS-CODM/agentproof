import type { FinancialState, PolicyEvaluation, Product, StructuredIntent } from '@agentproof/shared';
import { PolicyEngine } from '../policy/PolicyEngine.js';
import type { EvidenceService } from '../evidence/EvidenceService.js';
import { PayPalClient, PayPalError, type CreatedOrder, type PayPalCaptureResult } from './PayPalClient.js';

export type CreatePaymentOrderResult =
  | { kind: 'ORDER_CREATED'; order: CreatedOrder; evaluation: PolicyEvaluation; confirmationRequired: boolean }
  | { kind: 'CONFIRMATION_REQUIRED'; evaluation: PolicyEvaluation }
  | { kind: 'POLICY_DENIED'; evaluation: PolicyEvaluation };

export interface PaymentServiceDeps {
  policyEngine: PolicyEngine;
  evidence: EvidenceService;
  paypal: PayPalClient;
  persistTransactionState?: (update: {
    transactionId: string;
    financialState: FinancialState;
    paypalCaptureId: string | null;
    updatedAt: string;
  }) => void;
}

export type CapturePaymentResult =
  | { kind: 'PAYMENT_COMPLETED'; capture: PayPalCaptureResult; reconciled?: boolean }
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

  async createOrder(params: {
    intentId: string;
    intent: StructuredIntent;
    product: Product;
    confirmationApproved?: boolean;
  }): Promise<CreatePaymentOrderResult> {
    const { policyEngine, evidence, paypal } = this.deps;

    // 1. Deterministic policy check — sole authority.
    const evaluation = policyEngine.evaluate(params.intent, params.product);
    evaluation.intentId = params.intentId;

    evidence.record({
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
    });

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
    });

    evidence.record({
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
    });

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
      evidence.record({
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
      });
      return { kind: 'MISMATCHED_ORDER', reason: 'PayPal order does not match transaction' };
    }

    evidence.record({
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
    });

    // Reconcile: PayPal already captured but local state lagged.
    if (order.status === 'COMPLETED') {
      persistTransactionState?.({
        transactionId: params.transactionId,
        financialState: 'PAYMENT_COMPLETED',
        paypalCaptureId: null,
        updatedAt: now(),
      });
      evidence.record({
        eventType: 'PAYMENT_COMPLETED',
        actor: 'agent',
        source: 'paypal_api',
        intentId: params.intentId,
        transactionId: params.transactionId,
        policyEvaluationId: params.policyEvaluationId ?? undefined,
        data: { reason: 'reconciled_from_paypal_completed_order', paypalOrderId: order.id },
      });
      return {
        kind: 'PAYMENT_COMPLETED',
        reconciled: true,
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
        persistTransactionState?.({
          transactionId: params.transactionId,
          financialState: 'PAYMENT_COMPLETED',
          paypalCaptureId: null,
          updatedAt: now(),
        });
        evidence.record({
          eventType: 'PAYMENT_COMPLETED',
          actor: 'agent',
          source: 'paypal_api',
          intentId: params.intentId,
          transactionId: params.transactionId,
          policyEvaluationId: params.policyEvaluationId ?? undefined,
          data: { reason: 'reconciled_order_already_captured', paypalOrderId: params.paypalOrderId },
        });
        return {
          kind: 'PAYMENT_COMPLETED',
          reconciled: true,
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

    evidence.record({
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
    });

    persistTransactionState?.({
      transactionId: params.transactionId,
      financialState: 'PAYMENT_COMPLETED',
      paypalCaptureId: capture.captureId,
      updatedAt: now(),
    });

    evidence.record({
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
    });

    evidence.record({
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
    });

    return { kind: 'PAYMENT_COMPLETED', capture };
  }
}
