import type { PolicyEvaluation } from '@agentproof/shared';
import type { PolicyEvaluationRepository } from './PolicyEvaluationRepository.js';

type SqlJsDatabase = InstanceType<Awaited<ReturnType<typeof import('sql.js')>>['Database']>;

interface PolicyEvaluationRow {
  id: string;
  intent_id: string;
  product_id: string;
  result: string;
  confirmation_required: number;
  rule_results_json: string;
  evaluated_at: string;
}

/**
 * sql.js-backed implementation of the policy-evaluation repository.
 *
 * Internally synchronous; the Promise-based contract allows an asynchronous
 * MongoDB adapter later without changing callers.
 */
export class SQLitePolicyEvaluationRepository implements PolicyEvaluationRepository {
  constructor(private readonly db: SqlJsDatabase) {}

  async save(evaluation: PolicyEvaluation, userId?: string | null): Promise<void> {
    this.db.run(
      `INSERT INTO policy_evaluations (id, user_id, intent_id, product_id, result, confirmation_required, rule_results_json, evaluated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        evaluation.id,
        userId ?? null,
        evaluation.intentId,
        evaluation.productId,
        evaluation.result,
        evaluation.confirmationRequired ? 1 : 0,
        JSON.stringify(evaluation.ruleResults),
        evaluation.evaluatedAt,
      ],
    );
  }

  async listByIntentForUser(
    intentId: string,
    userId: string,
  ): Promise<PolicyEvaluation[]> {
    const stmt = this.db.prepare(
      `SELECT id, intent_id, product_id, result, confirmation_required,
              rule_results_json, evaluated_at
       FROM policy_evaluations
       WHERE intent_id = ? AND user_id = ?
       ORDER BY evaluated_at ASC, id ASC`,
    );
    stmt.bind([intentId, userId]);
    const evaluations: PolicyEvaluation[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as unknown as PolicyEvaluationRow;
      evaluations.push({
        id: row.id,
        intentId: row.intent_id,
        productId: row.product_id,
        result: row.result as PolicyEvaluation['result'],
        confirmationRequired: Boolean(row.confirmation_required),
        ruleResults: JSON.parse(row.rule_results_json),
        evaluatedAt: row.evaluated_at,
      });
    }
    stmt.free();
    return evaluations;
  }
}
