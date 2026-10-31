/**
 * Server-side policy for outbound retailer links.
 *
 * This is deliberately conservative: HTTPS only, no credentials, no unexpected
 * ports, no whitespace/control characters, exact-or-label-boundary hostname
 * matching, and rejection of absolute redirect destinations in query params.
 * The raw URL is returned unchanged on success so provider attribution
 * parameters are never stripped or reconstructed.
 */

export const RETAILER_AFFILIATE_DISCLOSURE =
  'We may earn a commission when you buy through links on this page.';

export const RETAILER_HANDOFF_DISCLOSURE_VERSION = 'channel3-affiliate-v1';

export type RetailerUrlRejection =
  | 'NOT_A_STRING'
  | 'MALFORMED'
  | 'UNSAFE_CHARACTERS'
  | 'NOT_HTTPS'
  | 'CREDENTIALS'
  | 'UNEXPECTED_PORT'
  | 'HOST_NOT_APPROVED'
  | 'UNSAFE_REDIRECT_PARAMETER';

export type RetailerUrlValidation =
  | { ok: true; url: string; hostname: string }
  | { ok: false; reason: RetailerUrlRejection };

export interface RetailerUrlPolicy {
  /** Merchant domain from the trusted offer snapshot, e.g. "shoebacca.com". */
  merchant: string | null;
  /**
   * Exact, operator-approved tracking hostnames. No automatic subdomain
   * expansion is performed for these entries.
   */
  allowedTrackingHosts: readonly string[];
}

const MAX_URL_LENGTH = 4096;

// Common query parameters that can turn an otherwise-approved link into an
// open redirect. Only absolute/protocol-relative values are rejected, so normal
// relative navigation parameters remain usable.
const REDIRECT_PARAMETER_NAMES = new Set([
  'url',
  'uri',
  'redirect',
  'redirect_uri',
  'redirect_url',
  'target',
  'u',
  'goto',
  'dest',
  'destination',
  'continue',
  'return',
  'returnurl',
  'return_url',
  'next',
  'out',
]);

function normalizeHost(host: string): string | null {
  const normalized = host.trim().toLowerCase().replace(/\.$/, '');
  if (normalized.length === 0) return null;
  if (
    normalized.includes('/') ||
    normalized.includes(':') ||
    normalized.includes('\\') ||
    normalized.includes('@') ||
    /\s/.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

/** Parse a provider-reported merchant domain without accepting a URL. */
function merchantHostname(merchant: string | null): string | null {
  if (!merchant) return null;
  try {
    const parsed = new URL(`https://${merchant}`);
    if (
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.port !== '' ||
      parsed.pathname !== '/' ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      return null;
    }
    return normalizeHost(parsed.hostname);
  } catch {
    return null;
  }
}

function isApprovedHost(
  hostname: string,
  merchantHost: string | null,
  allowedTrackingHosts: readonly string[],
): boolean {
  if (merchantHost) {
    // Exact merchant domain or a label-boundary subdomain. This deliberately
    // rejects suffix lookalikes such as "evil-shoebacca.com" and
    // "shoebacca.com.evil.example".
    if (hostname === merchantHost || hostname.endsWith(`.${merchantHost}`)) {
      return true;
    }
  }

  // Tracking hosts are exact matches only. Operators can list a specific
  // subdomain (for example "buy.trychannel3.com") but cannot widen trust to an
  // entire parent domain accidentally.
  return allowedTrackingHosts.some((host) => hostname === host);
}

function hasUnsafeRedirectParameter(url: URL): boolean {
  for (const [name, value] of url.searchParams) {
    if (!REDIRECT_PARAMETER_NAMES.has(name.toLowerCase())) continue;
    const destination = value.trim();
    if (
      /^[a-z][a-z0-9+.-]*:/i.test(destination) ||
      destination.startsWith('//') ||
      destination.startsWith('\\')
    ) {
      return true;
    }
  }
  return false;
}

export function validateRetailerUrl(
  raw: unknown,
  policy: RetailerUrlPolicy,
): RetailerUrlValidation {
  if (typeof raw !== 'string') return { ok: false, reason: 'NOT_A_STRING' };
  if (raw.length === 0 || raw.length > MAX_URL_LENGTH) {
    return { ok: false, reason: 'MALFORMED' };
  }
  if (raw !== raw.trim() || /[\s\\\u0000-\u001f\u007f]/.test(raw)) {
    return { ok: false, reason: 'UNSAFE_CHARACTERS' };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }

  if (url.protocol !== 'https:') return { ok: false, reason: 'NOT_HTTPS' };
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'CREDENTIALS' };
  }
  // URL normalizes an explicit :443 to ''; any other non-default port remains
  // populated and is rejected.
  if (url.port !== '') return { ok: false, reason: 'UNEXPECTED_PORT' };

  const hostname = normalizeHost(url.hostname);
  if (!hostname) return { ok: false, reason: 'MALFORMED' };

  const allowedTrackingHosts = policy.allowedTrackingHosts
    .map((host) => normalizeHost(host))
    .filter((host): host is string => host !== null);

  if (!isApprovedHost(hostname, merchantHostname(policy.merchant), allowedTrackingHosts)) {
    return { ok: false, reason: 'HOST_NOT_APPROVED' };
  }

  if (hasUnsafeRedirectParameter(url)) {
    return { ok: false, reason: 'UNSAFE_REDIRECT_PARAMETER' };
  }

  // Return the original string, not url.toString(), so attribution parameters
  // and provider formatting are preserved exactly.
  return { ok: true, url: raw, hostname };
}
