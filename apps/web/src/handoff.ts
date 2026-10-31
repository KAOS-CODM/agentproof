import type { OfferSnapshotView } from '@agentproof/shared';
import type { DiscoverCandidate } from './api';

export const RETAILER_AFFILIATE_DISCLOSURE =
  'We may earn a commission when you buy through links on this page.';

/**
 * Client-side defense-in-depth check before assigning `window.location`.
 * The server remains authoritative; this only rejects a response that is not a
 * plain HTTPS destination without credentials or a non-default port.
 */
export function isSafeRetailerNavigationUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.port === ''
    );
  } catch {
    return false;
  }
}

/** The persisted snapshot is the only source for retailer-facing offer details. */
export function offerForCandidate(
  candidate: DiscoverCandidate | null | undefined,
): OfferSnapshotView | null {
  return candidate?.snapshot ?? null;
}

/**
 * Verify that the server's handoff response describes the exact offer the user
 * is looking at. The handoff endpoint is authoritative for the URL, but a
 * mismatched identity means the client must not navigate.
 */
export function handoffOfferMatches(
  expected: OfferSnapshotView | null,
  received: OfferSnapshotView | null | undefined,
): boolean {
  return (
    expected !== null &&
    received != null &&
    received.id === expected.id &&
    received.source === expected.source &&
    received.productId === expected.productId &&
    received.price === expected.price &&
    received.currency === expected.currency
  );
}

export function formatOfferPrice(price: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
    }).format(price);
  } catch {
    return `${price.toFixed(2)} ${currency}`;
  }
}
