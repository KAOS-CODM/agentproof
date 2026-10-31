import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config/env.js';
import {
  getEvidenceService,
  getIntentRepository,
  getProductRepository,
  getTransactionRepository,
} from '../models/repositories.js';
import { PolicyEngine } from '../services/policy/PolicyEngine.js';
import { PaymentService } from '../services/paypal/PaymentService.js';
import { PayPalClient } from '../services/paypal/PayPalClient.js';
import { createProductResolutionService } from '../services/discovery/ProductResolutionService.js';
import { resolveDiscoveryProvider } from '../services/discovery/discoverySource.js';
import { OrderCreationService } from '../services/orders/OrderCreationService.js';
import { requireAuth } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';

export const paymentsRouter = Router();
paymentsRouter.use(requireAuth);

const policyEngine = new PolicyEngine();
const paypal = new PayPalClient();
// Resolve the discovery provider once, so an invalid value fails fast at
// startup (consistent with products.ts) rather than per request.
const discoveryProvider = resolveDiscoveryProvider();

/**
 * Reconcile completion evidence for an already-completed transaction.
 *
 * This is the only recovery invocation point: it is reachable when a capture
 * reports `evidenceIncomplete` and when a completed transaction is retried. It
 * reads the persisted transaction, never calls PayPal, never transitions state,
 * and writes only the deterministic completion events that are missing. It is
 * best-effort and safe to retry; callers surface `RECOVERY_PENDING` on failure.
 */
async function recoverEvidenceForCompletedTransaction(
  transactionId: string,
  userId: string,
): Promise<boolean> {
  try {
    const transaction = await getTransactionRepository().getByIdForUser(transactionId, userId);
    if (
      !transaction ||
      transaction.financialState !== 'PAYMENT_COMPLETED' ||
      !transaction.paypalOrderId
    ) {
      return false;
    }

    const outcome = await getEvidenceService().recoverCompletionEvidence({
      transactionId: transaction.id,
      intentId: transaction.intentId,
      orderId: transaction.paypalOrderId,
      userId,
      policyEvaluationId: transaction.policyEvaluationId,
      captureId: transaction.paypalCaptureId,
      amount: transaction.amount,
      currency: transaction.currency,
      reason: 'recovered_after_post_capture_evidence_failure',
    });

    if (outcome.recovered.length > 0) {
      logger.info('Recovered missing completion evidence', {
        transactionId,
        events: outcome.recovered,
      });
    }
    if (outcome.failed.length > 0) {
      logger.warn('Completion evidence recovery incomplete', {
        transactionId,
        events: outcome.failed,
      });
      return false;
    }
    return true;
  } catch (err) {
    // Server-side diagnostics only; the response keeps a stable, non-sensitive signal.
    logger.warn('Completion evidence recovery failed', {
      transactionId,
      error: err instanceof Error ? err.message : 'unknown',
    });
    return false;
  }
}

const createOrderRequestSchema = z.object({
  intentId: z.string().min(1),
  productId: z.string().min(1),
  confirmationApproved: z.boolean().optional(),
});

const captureRequestSchema = z.object({
  transactionId: z.string().min(1),
});

paymentsRouter.post('/capture', async (req, res) => {
  const parsed = captureRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }

  const evidenceService = getEvidenceService();
  const transactionRepository = getTransactionRepository();
  const userId = req.auth!.user.id;

  // Scoped lookup: an unknown id and another user's id both return 404.
  const transaction = await transactionRepository.getByIdForUser(
    parsed.data.transactionId,
    userId,
  );

  if (!transaction) {
    res.status(404).json({ error: 'Transaction not found' });
    return;
  }
  if (!transaction.paypalOrderId) {
    res.status(409).json({ error: 'Transaction has no PayPal order' });
    return;
  }

  const paymentService = new PaymentService({
    policyEngine,
    evidence: evidenceService,
    paypal,
    userId,
    // Conditional pending→completed transition. A repository error rejects and
    // surfaces as a 502; a lost race resolves `false` and the service reports
    // ALREADY_COMPLETED without emitting duplicate completion evidence.
    persistTransactionState: async (update) => {
      const result = await transactionRepository.completePayment({
        transactionId: update.transactionId,
        paypalCaptureId: update.paypalCaptureId,
        updatedAt: update.updatedAt,
        userId,
      });
      return result.kind === 'TRANSITIONED';
    },
  });

  try {
    const result = await paymentService.captureApprovedOrder({
      transactionId: transaction.id,
      intentId: transaction.intentId,
      productId: transaction.productId,
      paypalOrderId: transaction.paypalOrderId,
      expectedAmount: transaction.amount,
      expectedCurrency: transaction.currency,
      financialState: transaction.financialState,
      policyEvaluationId: transaction.policyEvaluationId,
    });

    switch (result.kind) {
      case 'PAYMENT_COMPLETED': {
        // At worst one bounded recovery attempt; it cannot capture or transition.
        const evidenceRecovered = result.evidenceIncomplete
          ? await recoverEvidenceForCompletedTransaction(transaction.id, userId)
          : true;
        res.json({
          transactionId: transaction.id,
          financialState: 'PAYMENT_COMPLETED',
          reconciled: result.reconciled ?? false,
          ...(result.evidenceIncomplete && !evidenceRecovered
            ? { evidenceIncomplete: true, evidenceStatus: 'RECOVERY_PENDING' }
            : {}),
          paypal: {
            orderId: result.capture.orderId,
            orderStatus: result.capture.orderStatus,
            captureId: result.capture.captureId,
            captureStatus: result.capture.captureStatus,
            amount: result.capture.amount,
            currency: result.capture.currency,
          },
        });
        return;
      }
      case 'ALREADY_COMPLETED': {
        // A retry of an already-completed transaction is the safe place to
        // reconcile evidence left behind by an earlier write failure.
        const evidenceRecovered = await recoverEvidenceForCompletedTransaction(transaction.id, userId);
        res.json({
          transactionId: transaction.id,
          financialState: 'PAYMENT_COMPLETED',
          alreadyCompleted: true,
          ...(evidenceRecovered
            ? {}
            : { evidenceIncomplete: true, evidenceStatus: 'RECOVERY_PENDING' }),
        });
        return;
      }
      case 'INVALID_STATE':
        res.status(409).json({ error: 'Transaction is not payable', financialState: result.financialState });
        return;
      case 'MISMATCHED_ORDER':
        res.status(409).json({ error: result.reason });
        return;
      case 'INVALID_ORDER_STATE':
        res.status(409).json({ error: 'PayPal order is not in a capturable state', paypalStatus: result.orderStatus });
        return;
      case 'CAPTURE_UNVERIFIED':
        res.status(502).json({ error: 'PayPal capture could not be verified', details: result.reason });
        return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'PayPal capture failed';
    logger.error('PayPal capture failed', { error: message });
    res.status(502).json({ error: 'PayPal capture failed', details: message });
  }
});

const productResolutionErrors: Record<
  'NOT_FOUND' | 'STALE' | 'UNUSABLE' | 'NOT_FOR_INTENT',
  { status: number; error: string }
> = {
  NOT_FOUND: { status: 404, error: 'Product not found' },
  STALE: { status: 409, error: 'Product data is stale; re-run discovery before purchasing' },
  UNUSABLE: { status: 422, error: 'Product data is unusable' },
  NOT_FOR_INTENT: { status: 404, error: 'Product not found for this intent' },
};

paymentsRouter.post('/create-order', async (req, res) => {
  const parsed = createOrderRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }

  const evidenceService = getEvidenceService();
  const resolver = createProductResolutionService(getProductRepository(), discoveryProvider);
  const intentRepository = getIntentRepository();
  const transactionRepository = getTransactionRepository();
  const userId = req.auth!.user.id;

  const orderCreation = new OrderCreationService({
    policyEngine,
    paypal,
    evidence: evidenceService,
    userId,
    // Authoritative intent context from the repository — scoped to this user, so
    // the client cannot override either the intent or its owner.
    getIntent: (intentId) => intentRepository.getStructuredByIdForUser(intentId, userId),
    // Authoritative product offer from the trusted server-side snapshot (or,
    // for the explicit demo provider, its in-memory catalog). Never from the
    // client and never a silent fallback.
    resolveProduct: (intentId, intent, productId) => resolver.resolve(intentId, intent, productId),
    // ORDER_CREATED → transaction starts PAYMENT_PENDING. Never PAYMENT_COMPLETED.
    persistOrder: (order) =>
      transactionRepository.insertPending({
        id: order.transactionId,
        userId,
        intentId: order.intentId,
        productId: order.productId,
        policyEvaluationId: order.policyEvaluationId,
        paypalOrderId: order.paypalOrderId,
        paypalCaptureId: null,
        amount: order.amount,
        currency: order.currency,
        financialState: 'PAYMENT_PENDING',
        createdAt: order.createdAt,
        updatedAt: order.createdAt,
      }),
    returnUrl: config.paypalReturnUrl || undefined,
    cancelUrl: config.paypalCancelUrl || undefined,
  });

  try {
    const outcome = await orderCreation.createOrder({
      intentId: parsed.data.intentId,
      productId: parsed.data.productId,
      confirmationApproved: parsed.data.confirmationApproved,
    });

    switch (outcome.kind) {
      case 'INTENT_NOT_FOUND':
        res.status(404).json({ error: 'Intent not found' });
        return;
      case 'PRODUCT_NOT_RESOLVED': {
        const mapped = productResolutionErrors[outcome.reason];
        res.status(mapped.status).json({ error: mapped.error });
        return;
      }
      case 'POLICY_DENIED':
        res.status(422).json({
          error: 'Policy denied this purchase',
          evaluation: outcome.evaluation,
        });
        return;
      case 'CONFIRMATION_REQUIRED':
        res.status(409).json({
          error: 'Human confirmation required before PayPal order creation',
          confirmationRequired: true,
          evaluation: outcome.evaluation,
        });
        return;
      case 'ORDER_CREATED':
        logger.info('PayPal sandbox order created', {
          transactionId: outcome.transactionId,
          paypalOrderId: outcome.order.id,
          status: outcome.order.status,
          financialState: 'PAYMENT_PENDING',
        });

        res.status(201).json({
          transactionId: outcome.transactionId,
          financialState: 'PAYMENT_PENDING',
          paypal: {
            orderId: outcome.order.id,
            status: outcome.order.status,
            approveUrl: outcome.order.approveUrl,
          },
          evaluation: outcome.evaluation,
          confirmationRequired: outcome.confirmationRequired,
        });
        return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'PayPal order creation failed';
    logger.error('PayPal order creation failed', { error: message });
    res.status(502).json({ error: 'PayPal order creation failed', details: message });
  }
});

paymentsRouter.get('/history', async (req, res) => {
  const transactionRepository = getTransactionRepository();
  const userId = req.auth!.user.id;

  const rawLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
  const limit =
    Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 25;
  const intentId = typeof req.query.intentId === 'string' ? req.query.intentId : undefined;

  // Ownership is part of the repository query. Passing another user's intent id
  // cannot widen the result; it simply returns an empty list.
  const transactions = await transactionRepository.listForUser(userId, limit, intentId);
  res.json(transactions);
});

paymentsRouter.get('/by-order/:orderId', async (req, res) => {
  const transactionRepository = getTransactionRepository();

  const transaction = await transactionRepository.getByPaypalOrderIdForUser(
    req.params.orderId,
    req.auth!.user.id,
  );

  if (!transaction) {
    res.status(404).json({ error: 'Transaction not found for this PayPal order' });
    return;
  }

  res.json({
    transactionId: transaction.id,
    intentId: transaction.intentId,
    financialState: transaction.financialState,
    amount: transaction.amount,
    currency: transaction.currency,
  });
});
