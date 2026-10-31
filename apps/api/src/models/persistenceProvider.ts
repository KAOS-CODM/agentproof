import { config } from '../config/env.js';

/**
 * Persistence-provider selection — P2-B.
 *
 * The application supports exactly two providers for the migrated domain
 * repositories:
 *
 *   - `sqlite`  (default) — the in-process sql.js store. Preserves all
 *     pre-P2-B behavior and requires no MongoDB configuration.
 *   - `mongodb` — MongoDB Atlas for intents, policy evaluations, evidence
 *     records, transactions, shared offers, and per-intent discoveries (see
 *     models/repositories.ts). No product/discovery data remains on SQLite in
 *     this mode.
 *
 * Design constraints:
 *   - No network access here. Selecting a provider only validates strings; the
 *     actual MongoDB connection happens in the startup path, never on import.
 *   - Never falls back silently. An explicit `mongodb` selection with missing
 *     configuration fails clearly.
 *   - Never logs or embeds credentials (validation delegates to
 *     `validateMongoConfig`, which names only the missing variable).
 */

export const PERSISTENCE_PROVIDERS = ['sqlite', 'mongodb'] as const;
export type PersistenceProvider = (typeof PERSISTENCE_PROVIDERS)[number];

/** Thrown when PERSISTENCE_PROVIDER is set to an unsupported value. */
export class InvalidPersistenceProviderError extends Error {
  constructor(value: string) {
    super(
      `Invalid PERSISTENCE_PROVIDER "${value}". Supported values are ` +
        `${PERSISTENCE_PROVIDERS.join(', ')}. There is no automatic fallback.`,
    );
    this.name = 'InvalidPersistenceProviderError';
  }
}

function isPersistenceProvider(value: string): value is PersistenceProvider {
  return (PERSISTENCE_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Resolve and validate the configured persistence provider.
 *
 * Accepts only the explicitly supported values (case-insensitively, trimmed).
 * An empty/unset value defaults to `sqlite` so existing behavior is preserved.
 * Throws `InvalidPersistenceProviderError` for anything else — it never coerces
 * an unknown value to a default.
 */
export function resolvePersistenceProvider(
  raw: string = config.persistenceProvider,
): PersistenceProvider {
  const value = raw.trim().toLowerCase();
  if (!value) return 'sqlite';
  if (!isPersistenceProvider(value)) throw new InvalidPersistenceProviderError(raw);
  return value;
}
