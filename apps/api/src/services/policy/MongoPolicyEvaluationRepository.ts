import type { PolicyEvaluation } from '@agentproof/shared';
import type { Db } from 'mongodb';
import type { PolicyEvaluationRepository } from './PolicyEvaluationRepository.js';

/**
 * MongoDB-backed implementation of the policy-evaluation repository.
 *
 * Document contract (`policyEvaluations`):
 *   { _id: string, intentId: string, productId: string, result: 'ALLOW'|'DENY',
 *     confirmationRequired: boolean, ruleResults: RuleResult[],
 *     evaluatedAt: Date }
 *
 * Append-only: `save()` only inserts. Evaluations are historical records and are
 * never mutated or overwritten, so a duplicate `_id` raises rather than upsert.
 * `evaluatedAt` is stored as a BSON `Date`.
 */

interface PolicyEvaluationDoc {
  _id: string;
  userId?: string;
  intentId: string;
  productId: string;
  result: PolicyEvaluation['result'];
  confirmationRequired: boolean;
  ruleResults: PolicyEvaluation['ruleResults'];
  evaluatedAt: Date;
}

export class MongoPolicyEvaluationRepository implements PolicyEvaluationRepository {
  constructor(private readonly db: Db) {}

  private get collection() {
    return this.db.collection<PolicyEvaluationDoc>('policyEvaluations');
  }

  async save(evaluation: PolicyEvaluation, userId?: string | null): Promise<void> {
    const doc: PolicyEvaluationDoc = {
      _id: evaluation.id,
      intentId: evaluation.intentId,
      productId: evaluation.productId,
      result: evaluation.result,
      confirmationRequired: evaluation.confirmationRequired,
      ruleResults: evaluation.ruleResults,
      evaluatedAt: new Date(evaluation.evaluatedAt),
    };
    if (userId) {
      (doc as any).userId = userId;
    }
    await this.collection.insertOne(doc);
  }

  async listByIntentForUser(
    intentId: string,
    userId: string,
  ): Promise<PolicyEvaluation[]> {
    const docs = await this.collection
      .find({ intentId, userId })
      .sort({ evaluatedAt: 1 })
      .toArray();
    return docs.map((doc) => ({
      id: doc._id,
      intentId: doc.intentId,
      productId: doc.productId,
      result: doc.result,
      confirmationRequired: doc.confirmationRequired,
      ruleResults: doc.ruleResults,
      evaluatedAt: doc.evaluatedAt.toISOString(),
    }));
  }
}
