import type { PolicyEvaluation, StructuredIntent } from '@agentproof/shared';
import { PaymentService } from '../paypal/PaymentService.js';
import type { CreatedOrder, PayPalClient } from '../paypal/PayPalClient.js';
import type { PolicyEngine } from '../policy/PolicyEngine.js';
import type { EvidenceService } from '../evidence/EvidenceService.js';
import type { ProductResolution } from '../discovery/ProductResolutionService.js';
import { generateId } from '../../utils/id.js';

/** A transaction row to persist for a freshly created (unpaid) order. */
export interface PersistedOrder {
  transactionId: string;
  userId?: string | null;
  intentId: string;
  productId: string;
  policyEvaluationId: string;
  paypalOrderId: string;
  amount: number;
  currency: string;
  createdAt: string;
}

export type ProductResolutionFailure = Exclude<ProductResolution['kind'], 'RESOLVED'>;

export type OrderCreationOutcome =
  | { kind: 'INTENT_NOT_FOUND' }
  | { kind: 'PRODUCT_NOT_RESOLVED'; reason: ProductResolutionFailure }
  | { kind: 'POLICY_DENIED'; evaluation: PolicyEvaluation }
  | { kind: 'CONFIRMATION_REQUIRED'; evaluation: PolicyEvaluation }
  | {
      kind: 'ORDER_CREATED';
      transactionId: string;
      order: CreatedOrder;
      evaluation: PolicyEvaluation;
      confirmationRequired: boolean;
    };

export interface OrderCreationDeps {
  policyEngine: PolicyEngine;
  paypal: PayPalClient;
  evidence: EvidenceService;
  /** Trusted owner for evidence and persisted transactions. */
  userId?: string | null;
  /** Load the authoritative structured intent (never from the client). */
  getIntent: (intentId: string) => Promise<StructuredIntent | null>;
  /** Resolve the authoritative product offer for this intent + product id. */
  resolveProduct: (
    intentId: string,
    intent: StructuredIntent,
    productId: string,
  ) => Promise<ProductResolution>;
  /** Persist the created order as PAYMENT_PENDING. */
  persistOrder: (order: PersistedOrder) => Promise<void>;
  returnUrl?: string;
  cancelUrl?: string;
}

/**
 * Orchestrates order creation at the request boundary:
 *   authoritative intent → authoritative product → PolicyEngine → PayPal order
 *   → persist a PAYMENT_PENDING transaction.
 *
 * It never trusts client-supplied product attributes (they are not even part
 * of its input), and it creates no PayPal order and persists no transaction
 * unless both product resolution AND policy authorization succeed. Financial
 * state transitions (capture/approval) remain entirely in PaymentService and
 * are never touched here.
 */
export class OrderCreationService {
  constructor(private readonly deps: OrderCreationDeps) {}

  private get userId(): string | null {
    return this.deps.userId ?? null;
  }

  async createOrder(params: {
    intentId: string;
    productId: string;
    confirmationApproved?: boolean;
  }): Promise<OrderCreationOutcome> {
    const { policyEngine, paypal, evidence, getIntent, resolveProduct, persistOrder } = this.deps;

    const intent = await getIntent(params.intentId);
    if (!intent) return { kind: 'INTENT_NOT_FOUND' };

    const resolution = await resolveProduct(params.intentId, intent, params.productId);
    if (resolution.kind !== 'RESOLVED') {
      return { kind: 'PRODUCT_NOT_RESOLVED', reason: resolution.kind };
    }

    const product = resolution.product;
    const paymentService = new PaymentService({
      policyEngine,
      evidence,
      paypal,
      userId: this.userId,
    });

    const result = await paymentService.createOrder({
      intentId: params.intentId,
      intent,
      product,
      confirmationApproved: params.confirmationApproved,
      returnUrl: this.deps.returnUrl,
      cancelUrl: this.deps.cancelUrl,
    });

    if (result.kind === 'POLICY_DENIED') {
      return { kind: 'POLICY_DENIED', evaluation: result.evaluation };
    }
    if (result.kind === 'CONFIRMATION_REQUIRED') {
      return { kind: 'CONFIRMATION_REQUIRED', evaluation: result.evaluation };
    }

    // Amount, currency, and product id all come from the same resolved offer.
    const transactionId = generateId();
    await persistOrder({
      transactionId,
      userId: this.userId,
      intentId: params.intentId,
      productId: product.id,
      policyEvaluationId: result.evaluation.id,
      paypalOrderId: result.order.id,
      amount: product.price,
      currency: product.currency,
      createdAt: new Date().toISOString(),
    });

    return {
      kind: 'ORDER_CREATED',
      transactionId,
      order: result.order,
      evaluation: result.evaluation,
      confirmationRequired: result.confirmationRequired,
    };
  }
}
