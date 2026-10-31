import type { DiscoverCandidate } from '../api';
import type { CandidateSelectionState } from '../selection';

interface Props {
  candidate: DiscoverCandidate;
  state: CandidateSelectionState;
  disabled?: boolean;
  onSelect?: () => void;
}

export function CandidateCard({ candidate, state, disabled = false, onSelect }: Props) {
  const { product, evaluation, snapshot } = candidate;
  const allowed = evaluation.result === 'ALLOW';
  const price = snapshot?.price ?? product.price;
  const currency = snapshot?.currency ?? product.currency;
  const merchant = snapshot?.merchant ?? product.merchant;
  const selected = state === 'persisted';
  const pending = state === 'pending';
  const fresh = candidate.snapshotFresh === true;
  const selectable =
    allowed && Boolean(snapshot) && fresh && !disabled && !selected && !pending;

  return (
    <div className={`candidate-card ${allowed ? 'candidate-card--allowed' : 'candidate-card--denied'} ${selected || pending ? 'candidate-card--selected' : ''}`}>
      <div className="candidate-header">
        <span className="candidate-name">{product.name}</span>
        <span className={`badge ${allowed ? 'badge--allow' : 'badge--deny'}`}>
          {allowed ? 'ALLOW' : 'DENY'}
        </span>
      </div>
      <div className="candidate-meta">
        <span>{product.brand}</span>
        <span className="candidate-sep">·</span>
        <span>{product.category}</span>
        <span className="candidate-sep">·</span>
        <span>{product.condition}</span>
        {merchant && (
          <>
            <span className="candidate-sep">·</span>
            <span>{merchant}</span>
          </>
        )}
      </div>
      <div className="candidate-price">{price} {currency}</div>
      <div className="policy-eval">
        <span className="policy-eval-title">Policy evaluation</span>
        <ul className="rule-results">
          {evaluation.ruleResults.map((r, i) => (
            <li key={i} className={`rule-result ${r.passed ? 'rule-result--pass' : 'rule-result--fail'}`}>
              <span className="rule-icon">{r.passed ? '✓' : '✕'}</span>
              <span className="rule-name">{r.rule}</span>
              {r.reason && <span className="rule-reason">{r.reason}</span>}
            </li>
          ))}
        </ul>
      </div>
      {evaluation.confirmationRequired && (
        <span className="badge badge--confirm">Confirmation required</span>
      )}
      {allowed && state !== 'none' && (
        <div className="candidate-provenance">
          {state === 'persisted' && (
            <span className="badge badge--allow">Your selection</span>
          )}
          {state === 'pending' && (
            <span className="badge badge--pending">Saving selection…</span>
          )}
          {state === 'recommendation' && (
            <span className="badge badge--confirm">AI recommendation</span>
          )}
          {state === 'fallback' && (
            <span className="badge badge--confirm">Fallback option</span>
          )}
          {state === 'previously_saved' && (
            <span className="badge badge--confirm">Previously saved — not current</span>
          )}
          {state === 'save_failed' && (
            <span className="badge badge--deny">Selection not saved</span>
          )}
        </div>
      )}
      {allowed && !snapshot && (
        <p className="payment-hint">
          No immutable offer snapshot is available for this option. Re-run discovery before
          selecting it.
        </p>
      )}
      {allowed && snapshot && !fresh && (
        <p className="payment-hint">
          This offer is older than AgentProof&apos;s freshness window. Re-run discovery before
          selecting it.
        </p>
      )}
      {allowed && onSelect && (
        <button
          type="button"
          className={`btn btn-primary btn-select ${selected ? 'btn-select--selected' : ''}`}
          onClick={onSelect}
          disabled={!selectable}
        >
          {selected
            ? 'Selected'
            : pending
              ? 'Saving…'
              : state === 'previously_saved' || state === 'save_failed'
                ? 'Save again'
                : 'Select offer'}
        </button>
      )}
    </div>
  );
}
