import type { z } from 'zod';
import type {
  structuredIntentSchema,
  productSchema,
  policyEvaluationSchema,
  ruleResultSchema,
  evidenceRecordSchema,
  financialStateSchema,
  actionTypeSchema,
  authorityStatusSchema,
  actionAuthorizationSchema,
} from './schemas.js';

export type StructuredIntent = z.infer<typeof structuredIntentSchema>;
export type Product = z.infer<typeof productSchema>;
export type PolicyEvaluation = z.infer<typeof policyEvaluationSchema>;
export type RuleResult = z.infer<typeof ruleResultSchema>;
export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;
export type FinancialState = z.infer<typeof financialStateSchema>;
export type ActionType = z.infer<typeof actionTypeSchema>;
export type AuthorityStatus = z.infer<typeof authorityStatusSchema>;
export type ActionAuthorization = z.infer<typeof actionAuthorizationSchema>;

export interface Intent {
  id: string;
  rawInput: string;
  structured: StructuredIntent;
  status: 'PENDING' | 'PARSED' | 'VALIDATED' | 'EXPIRED';
  createdAt: string;
  parsedAt: string | null;
  validatedAt: string | null;
}

export interface Transaction {
  id: string;
  intentId: string;
  productId: string;
  policyEvaluationId: string;
  paypalOrderId: string | null;
  paypalCaptureId: string | null;
  amount: number;
  currency: string;
  financialState: FinancialState;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalRequest {
  id: string;
  transactionId: string;
  action: ActionType;
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED';
  requestedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  evidenceIds: string[];
}
