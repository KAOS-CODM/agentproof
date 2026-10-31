/**
 * Safe, diagnostic-only extraction of transport-level failure details.
 *
 * Node's global `fetch` (undici) surfaces connection/DNS/TLS problems as a
 * generic `TypeError: fetch failed`, with the actionable code hidden on
 * `error.cause`. These helpers pull out a small, fixed set of non-sensitive
 * identifiers so failures can be told apart in logs.
 *
 * They deliberately never read or return request bodies, headers, URLs with
 * query strings, tokens, or the full error object — only `name`,
 * `cause.code`, `cause.syscall`, and `cause.hostname`.
 */

interface ErrorCauseLike {
  code?: unknown;
  syscall?: unknown;
  hostname?: unknown;
}

export interface TransportDiagnostic {
  name: string | null;
  code: string | null;
  syscall: string | null;
  hostname: string | null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Extract the safe diagnostic fields from a caught error.
 * Returns null when the error is not an `Error` or none of the fields exist.
 */
export function extractTransportDiagnostic(err: unknown): TransportDiagnostic | null {
  if (!(err instanceof Error)) return null;

  const cause = (err as { cause?: unknown }).cause;
  const causeLike: ErrorCauseLike = cause && typeof cause === 'object' ? (cause as ErrorCauseLike) : {};

  const diagnostic: TransportDiagnostic = {
    name: nonEmptyString(err.name),
    code: nonEmptyString(causeLike.code),
    syscall: nonEmptyString(causeLike.syscall),
    hostname: nonEmptyString(causeLike.hostname),
  };

  if (!diagnostic.name && !diagnostic.code && !diagnostic.syscall && !diagnostic.hostname) {
    return null;
  }
  return diagnostic;
}

/**
 * Render an error-message suffix such as
 * ` [name=TypeError code=EAI_AGAIN syscall=getaddrinfo hostname=openrouter.ai]`.
 * Returns an empty string when no safe diagnostic is available.
 */
export function formatTransportDiagnostic(err: unknown): string {
  const diagnostic = extractTransportDiagnostic(err);
  if (!diagnostic) return '';

  const parts: string[] = [];
  if (diagnostic.name) parts.push(`name=${diagnostic.name}`);
  if (diagnostic.code) parts.push(`code=${diagnostic.code}`);
  if (diagnostic.syscall) parts.push(`syscall=${diagnostic.syscall}`);
  if (diagnostic.hostname) parts.push(`hostname=${diagnostic.hostname}`);

  return ` [${parts.join(' ')}]`;
}
