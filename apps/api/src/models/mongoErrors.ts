/**
 * Minimal, shared MongoDB error classification.
 *
 * Only the structured driver error code is inspected. Error *messages* are not
 * used: an unrelated failure whose text mentions "duplicate" must never be
 * reclassified as an idempotent duplicate-key outcome.
 */
export function isDuplicateKeyError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; writeErrors?: unknown[] };
  if (e.code === 11000) return true;
  return (
    Array.isArray(e.writeErrors) &&
    e.writeErrors.some((w) => (w as { code?: unknown } | null)?.code === 11000)
  );
}
