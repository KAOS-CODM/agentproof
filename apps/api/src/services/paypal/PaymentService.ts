import type { PolicyEvaluation, Product, StructuredIntent } from '@agentproof/shared';
import { PolicyEngine } from '../policy/PolicyEngine.js';
import type { EvidenceService } from '../evidence/EvidenceService.js';
import { PayPalClient, type CreatedOrder } from './PayPalClient.js';

export type CreatePaymentOrderResult =
  | { kind: 'ORDER_CREATED'; order: CreatedOrder; evaluation: PolicyEvaluation; confirmationRequired: boolean }
  | { kind: 'CONFIRMATION_REQUIRED'; evaluation: PolicyEvaluation }
  | { kind: 'POLICY_DENIED'; evaluation: PolicyEvaluation };

export interface PaymentServiceDeps {
  policyEngine: PolicyEngine;
  evidence: EvidenceService;
  paypal: PayPalClient;
}

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
}
