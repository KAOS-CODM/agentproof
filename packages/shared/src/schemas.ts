import { z } from 'zod';

// ── Intent ──────────────────────────────────────────────────────────────────

export const constraintSchema = z.object({
  type: z.string(),
  value: z.union([z.string(), z.number(), z.array(z.string())]),
  operator: z.enum(['eq', 'lt', 'lte', 'gt', 'gte', 'in']),
});

export const structuredIntentSchema = z.object({
  purpose: z.string().min(1),
  maxAmount: z.number().positive(),
  currency: z.string().length(3),
  brands: z.array(z.string()),
  condition: z.enum(['new', 'used', 'any']),
  requiresConfirmationAbove: z.number().positive().nullable(),
  constraints: z.array(constraintSchema),
});

export const intentCreateSchema = z.object({
  rawInput: z.string().min(1),
  structured: structuredIntentSchema.optional(),
});

// ── Product Discovery ───────────────────────────────────────────────────────

export const productDiscoverRequestSchema = z
  .object({
    intentId: z.string().min(1).optional(),
    structuredIntent: structuredIntentSchema.optional(),
  })
  .refine((v) => v.intentId !== undefined || v.structuredIntent !== undefined, {
    message: 'Provide either intentId or structuredIntent',
  });

// ── Product ─────────────────────────────────────────────────────────────────

export const productSchema = z.object({
  id: z.string().min(1),
  source: z.enum(['channel3', 'demo_catalog']),
  name: z.string().min(1),
  description: z.string(),
  price: z.number().positive(),
  currency: z.string().length(3),
  brand: z.string().min(1),
  condition: z.enum(['new', 'used']),
  category: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
});

// ── Policy ──────────────────────────────────────────────────────────────────

export const ruleResultSchema = z.object({
  rule: z.string(),
  passed: z.boolean(),
  actual: z.union([z.string(), z.number()]),
  expected: z.union([z.string(), z.number()]),
  reason: z.string().nullable(),
});

export const policyEvaluationSchema = z.object({
  id: z.string().min(1),
  intentId: z.string().min(1),
  productId: z.string().min(1),
  result: z.enum(['ALLOW', 'DENY']),
  confirmationRequired: z.boolean(),
  ruleResults: z.array(ruleResultSchema),
  evaluatedAt: z.string(),
});

export const policyEvaluateRequestSchema = z.object({
  intentId: z.string().min(1),
  productId: z.string().min(1),
  structuredIntent: structuredIntentSchema,
  product: productSchema,
});

// ── Evidence ────────────────────────────────────────────────────────────────

export const evidenceRecordSchema = z.object({
  id: z.string().min(1),
  eventType: z.string().min(1),
  timestamp: z.string(),
  actor: z.enum(['user', 'llm', 'policy_engine', 'paypal', 'agent', 'human']),
  transactionId: z.string().nullable(),
  intentId: z.string().nullable(),
  approvalRequestId: z.string().nullable(),
  policyEvaluationId: z.string().nullable(),
  data: z.record(z.unknown()),
  metadata: z.object({
    source: z.string().min(1),
    correlationId: z.string().min(1),
  }),
});

// ── Financial State ─────────────────────────────────────────────────────────

export const financialStateSchema = z.enum([
  'INTENT_CREATED',
  'PRODUCT_SELECTED',
  'PAYMENT_PENDING',
  'PAYMENT_COMPLETED',
  'FULFILLMENT',
  'DELIVERED',
  'DISPUTE_OPENED',
  'EVIDENCE_REVIEW',
  'RESOLVED',
]);

// ── Authority State ─────────────────────────────────────────────────────────

export const actionTypeSchema = z.enum([
  'PURCHASE',
  'REFUND',
  'DISPUTE_RESPONSE',
  'CANCEL_ORDER',
]);

export const authorityStatusSchema = z.enum([
  'NOT_REQUIRED',
  'PENDING',
  'APPROVAL_REQUIRED',
  'APPROVED',
  'DENIED',
  'EXECUTED',
]);

export const actionAuthorizationSchema = z.object({
  action: actionTypeSchema,
  transactionId: z.string().min(1),
  status: authorityStatusSchema,
  approvalRequestId: z.string().nullable(),
});
