import type { OfferSnapshotView } from '@agentproof/shared';
import { formatOfferPrice, RETAILER_AFFILIATE_DISCLOSURE } from '../handoff';

interface Props {
  /** Server-controlled flag. Rendering nothing is the safe default. */
  enabled: boolean;
  /** Server-derived eligibility (fresh snapshot and handoff enabled). */
  eligible: boolean;
  /** Immutable offer captured for this intent, or null for legacy records. */
  snapshot: OfferSnapshotView | null;
  loading: boolean;
  error: string | null;
  onContinue: () => void;
}

function formatCapturedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function RetailerHandoff({
  enabled,
  eligible,
  snapshot,
  loading,
  error,
  onContinue,
}: Props) {
  if (!enabled) return null;

  return (
    <section className="panel handoff-panel" aria-labelledby="handoff-title">
      <div className="handoff-header">
        <div>
          <h3 id="handoff-title" className="handoff-title">
            Retailer offer
          </h3>
          <p className="handoff-subtitle">
            This is the offer captured for this workflow. Continue to the
            retailer's own site to check out.
          </p>
        </div>
      </div>

      {snapshot && eligible ? (
        <>
          <dl className="handoff-details">
            <div>
              <dt>Merchant</dt>
              <dd>{snapshot.merchant ?? 'Not provided'}</dd>
            </div>
            <div>
              <dt>Price</dt>
              <dd>
                {formatOfferPrice(snapshot.price, snapshot.currency)} {snapshot.currency}
              </dd>
            </div>
            {snapshot.compareAtPrice !== null && (
              <div>
                <dt>Compare at</dt>
                <dd>
                  {formatOfferPrice(snapshot.compareAtPrice, snapshot.currency)}{' '}
                  {snapshot.currency}
                </dd>
              </div>
            )}
            <div>
              <dt>Availability</dt>
              <dd>{snapshot.availability ?? 'Not provided'}</dd>
            </div>
            <div>
              <dt>Condition</dt>
              <dd>{snapshot.condition ?? 'Not provided'}</dd>
            </div>
            <div>
              <dt>Offer captured</dt>
              <dd>{formatCapturedAt(snapshot.capturedAt)}</dd>
            </div>
          </dl>

          <p className="handoff-disclosure">{RETAILER_AFFILIATE_DISCLOSURE}</p>

          {error && (
            <p className="handoff-error" role="alert">
              {error}
            </p>
          )}

          <button
            type="button"
            className="btn btn-secondary handoff-button"
            onClick={onContinue}
            disabled={loading}
          >
            {loading ? 'Preparing retailer link…' : 'Continue to retailer'}
          </button>
          <p className="handoff-note">
            You will complete your purchase on the merchant's site. AgentProof
            does not process that order, and continuing does not confirm a
            purchase.
          </p>
        </>
      ) : (
        <div className="handoff-fallback">
          <p>
            {snapshot
              ? 'This saved offer is older than AgentProof’s freshness window, so the retailer link is unavailable.'
              : 'No immutable offer snapshot is available for this saved offer.'}{' '}
            Re-run discovery to capture a current offer before continuing to
            the retailer.
          </p>
          {error && (
            <p className="handoff-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
