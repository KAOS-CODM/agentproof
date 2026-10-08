import { Router } from 'express';
import { z } from 'zod';
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
