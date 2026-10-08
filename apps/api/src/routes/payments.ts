import { Router } from 'express';
import { z } from 'zod';
import type { FinancialState } from '@agentproof/shared';
import { getDb } from '../models/db.js';
import { EvidenceService } from '../services/evidence/EvidenceService.js';
import { SQLiteEvidenceRepository } from '../services/evidence/SQLiteEvidenceRepository.js';
import { PolicyEngine } from '../services/policy/PolicyEngine.js';
import { DemoCatalogService } from '../services/discovery/DemoCatalogService.js';
import { PaymentService } from '../services/paypal/PaymentService.js';
import { PayPalClient } from '../services/paypal/PayPalClient.js';
import { generateId } from '../utils/id.js';
import { logger } from '../utils/logger.js';

export const paymentsRouter = Router();

const policyEngine = new PolicyEngine();
const catalog = new DemoCatalogService();
const paypal = new PayPalClient();

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

  const db = getDb();
  const evidenceService = new EvidenceService(new SQLiteEvidenceRepository(db));

  const stmt = db.prepare(
    'SELECT id, intent_id, product_id, policy_evaluation_id, paypal_order_id, amount, currency, financial_state FROM transactions WHERE id = ?',
  );
  stmt.bind([parsed.data.transactionId]);
  interface TxRow {
    id: string;
    intent_id: string;
    product_id: string;
    policy_evaluation_id: string;
    paypal_order_id: string | null;
    amount: number;
    currency: string;
    financial_state: string;
  }
  let row: TxRow | null = null;
  if (stmt.step()) {
    row = stmt.getAsObject() as unknown as TxRow;
  }
  stmt.free();

  if (!row) {
    res.status(404).json({ error: 'Transaction not found' });
    return;
  }
  if (!row.paypal_order_id) {
    res.status(409).json({ error: 'Transaction has no PayPal order' });
    return;
  }

  const paymentService = new PaymentService({
    policyEngine,
    evidence: evidenceService,
    paypal,
    persistTransactionState: (update) => {
      db.run(
        'UPDATE transactions SET financial_state = ?, paypal_capture_id = ?, updated_at = ? WHERE id = ?',
        [update.financialState, update.paypalCaptureId, update.updatedAt, update.transactionId],
      );
    },
  });

  try {
    const result = await paymentService.captureApprovedOrder({
      transactionId: row.id,
      intentId: row.intent_id,
      productId: row.product_id,
      paypalOrderId: row.paypal_order_id,
      expectedAmount: row.amount,
      expectedCurrency: row.currency,
      financialState: row.financial_state as FinancialState,
      policyEvaluationId: row.policy_evaluation_id,
    });

    switch (result.kind) {
      case 'PAYMENT_COMPLETED':
        res.json({
          transactionId: row.id,
          financialState: 'PAYMENT_COMPLETED',
          reconciled: result.reconciled ?? false,
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
      case 'ALREADY_COMPLETED':
        res.json({ transactionId: row.id, financialState: 'PAYMENT_COMPLETED', alreadyCompleted: true });
        return;
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

paymentsRouter.post('/create-order', async (req, res) => {
  const parsed = createOrderRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }

  const db = getDb();
  const evidenceService = new EvidenceService(new SQLiteEvidenceRepository(db));

  // Authoritative intent context from the DB — client cannot override it.
  const intentStmt = db.prepare('SELECT structured_json FROM intents WHERE id = ?');
  intentStmt.bind([parsed.data.intentId]);
  let intentRow: { structured_json: string } | null = null;
  if (intentStmt.step()) {
    intentRow = intentStmt.getAsObject() as unknown as { structured_json: string };
  }
  intentStmt.free();
  if (!intentRow) {
    res.status(404).json({ error: 'Intent not found' });
    return;
  }
  const structuredIntent = JSON.parse(intentRow.structured_json);

  // Authoritative product from the demo catalog — never trust client price/currency.
  const products = await catalog.search(structuredIntent);
  const product = products.find((p) => p.id === parsed.data.productId);
  if (!product) {
    res.status(404).json({ error: 'Product not found in catalog' });
    return;
  }

  const paymentService = new PaymentService({ policyEngine, evidence: evidenceService, paypal });

  try {
    const result = await paymentService.createOrder({
      intentId: parsed.data.intentId,
      intent: structuredIntent,
      product,
      confirmationApproved: parsed.data.confirmationApproved,
    });

    if (result.kind === 'POLICY_DENIED') {
      res.status(422).json({
        error: 'Policy denied this purchase',
        evaluation: result.evaluation,
      });
      return;
    }

    if (result.kind === 'CONFIRMATION_REQUIRED') {
      res.status(409).json({
        error: 'Human confirmation required before PayPal order creation',
        confirmationRequired: true,
        evaluation: result.evaluation,
      });
      return;
    }

    // ORDER_CREATED → transaction starts PAYMENT_PENDING. Never PAYMENT_COMPLETED.
    const now = new Date().toISOString();
    const transactionId = generateId();
    db.run(
      `INSERT INTO transactions (id, intent_id, product_id, policy_evaluation_id, paypal_order_id, paypal_capture_id, amount, currency, financial_state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        transactionId,
        parsed.data.intentId,
        product.id,
        result.evaluation.id,
        result.order.id,
        null,
        product.price,
        product.currency,
        'PAYMENT_PENDING',
        now,
        now,
      ],
    );

    logger.info('PayPal sandbox order created', {
      transactionId,
      paypalOrderId: result.order.id,
      status: result.order.status,
      financialState: 'PAYMENT_PENDING',
    });

    res.status(201).json({
      transactionId,
      financialState: 'PAYMENT_PENDING',
      paypal: {
        orderId: result.order.id,
        status: result.order.status,
        approveUrl: result.order.approveUrl,
      },
      evaluation: result.evaluation,
      confirmationRequired: result.confirmationRequired,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'PayPal order creation failed';
    logger.error('PayPal order creation failed', { error: message });
    res.status(502).json({ error: 'PayPal order creation failed', details: message });
  }
});
