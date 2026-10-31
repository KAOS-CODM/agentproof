import type { PolicyEvaluation } from '@agentproof/shared';

/**
 * Append-only store for policy evaluations.
 *
 * A policy evaluation is the deterministic record of what the PolicyEngine
 * decided for an intent/product pair. Evaluations are never mutated, so only
 * persistence and user-scoped retrieval are exposed. Retrieval exists for
 * restoring a signed-in user's saved workflow, never for rewriting history.
 *
 * The Promise-based contract matches the other repositories so a synchronous
 * SQLite adapter and an asynchronous MongoDB adapter are interchangeable.
 */
export interface PolicyEvaluationRepository {
  /** Persist a policy evaluation. */
  save(evaluation: PolicyEvaluation, userId?: string | null): Promise<void>;

  /**
   * Load one owner's evaluations for an intent, oldest first. This preserves the
   * order in which the policy engine evaluated each candidate.
   */
  listByIntentForUser(intentId: string, userId: string): Promise<PolicyEvaluation[]>;
}
