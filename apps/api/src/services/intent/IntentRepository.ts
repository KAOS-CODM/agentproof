import type { Intent, StructuredIntent } from '@agentproof/shared';

/**
 * Persisted intent record. Mirrors the shared `Intent` domain type but keeps
 * the persistence-layer input explicit (structured intent is already parsed).
 */
export interface PersistedIntent {
  id: string;
  userId?: string | null;
  rawInput: string;
  structured: StructuredIntent;
  status: Intent['status'];
  createdAt: string;
  parsedAt: string | null;
  validatedAt: string | null;
}

/**
 * Server-side store for created intents.
 *
 * Intents are the authoritative source of the structured request used during
 * order creation; they are never trusted from the client. The Promise-based
 * contract allows a synchronous SQLite adapter today and an asynchronous
 * MongoDB adapter later.
 */
export interface IntentRepository {
  /** Persist a newly created intent. */
  create(intent: PersistedIntent): Promise<void>;

  /** Load an intent by id, or null when it is unknown. */
  getById(id: string): Promise<Intent | null>;

  /** Load an intent by id scoped to a user, or null when unknown or not owned. */
  getByIdForUser(id: string, userId: string): Promise<Intent | null>;

  /**
   * Load a user's persisted intents, most recent first. This is the durable
   * history source for the signed-in workflow; ownerless/legacy rows are never
   * included because they have no trusted owner.
   */
  listForUser(userId: string, limit: number): Promise<Intent[]>;

  /**
   * Load only the structured intent for an id (the shape needed by the order
   * creation path), or null when the intent is unknown or unparseable.
   */
  getStructuredById(id: string): Promise<StructuredIntent | null>;

  /**
   * Load only the structured intent for an id scoped to a user.
   */
  getStructuredByIdForUser(id: string, userId: string): Promise<StructuredIntent | null>;
}
