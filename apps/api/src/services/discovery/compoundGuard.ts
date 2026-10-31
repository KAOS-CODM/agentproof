/**
 * Deterministic compound-intent guard.
 *
 * Detects when a raw input asks for multiple distinct product categories
 * joined by "and" (e.g. "shoes and watch", "running shoes and a watch").
 *
 * This is a conservative safeguard that runs independently of the LLM's
 * `isCompound` flag. It only detects clear cases where "and" joins two
 * product-like phrases. It does NOT detect "or" requests or implicit
 * multi-item requests (e.g. "shoes, watch, and a case").
 *
 * Returns true when the request appears to be compound.
 */
export function detectCompoundIntent(rawInput: string): boolean {
  const normalized = rawInput.toLowerCase().trim();
  const parts = normalized.split(/\s+and\s+/);

  if (parts.length < 2) return false;

  const productParts = parts.filter((p) => p.trim().length >= 2);
  if (productParts.length < 2) return false;

  const commonAdjectives = new Set([
    'new', 'used', 'cheap', 'expensive', 'good', 'best', 'great',
    'small', 'large', 'big', 'little', 'red', 'blue', 'green',
    'black', 'white', 'waterproof', 'wireless', 'smart', 'digital',
    'analog', 'fast', 'slow', 'light', 'heavy', 'nice', 'cool',
  ]);

  const meaningfulParts = productParts.filter((p) => {
    const words = p.trim().split(/\s+/);
    return words.some((w) => !commonAdjectives.has(w));
  });

  return meaningfulParts.length >= 2;
}
