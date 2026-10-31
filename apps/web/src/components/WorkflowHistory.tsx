import type { Transaction } from '@agentproof/shared';
import type { IntentResponse } from '../api';
import { latestTransaction, transactionStatusLabel } from '../workflow';

interface Props {
  intents: IntentResponse[];
  transactions: Transaction[];
  selectedIntentId: string | null;
  loading: boolean;
  error: string | null;
  onSelect: (intentId: string) => void;
  onNew: () => void;
  onRefresh: () => void;
}

function formatHistoryDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function WorkflowHistory({
  intents,
  transactions,
  selectedIntentId,
  loading,
  error,
  onSelect,
  onNew,
  onRefresh,
}: Props) {
  return (
    <section className="panel history-panel" aria-labelledby="history-title">
      <div className="history-header">
        <div>
          <h2 className="panel-title" id="history-title">Saved workflows</h2>
          <p className="history-subtitle">
            Persisted for your account and restored after a refresh.
          </p>
        </div>
        <div className="history-actions">
          <button className="btn btn-secondary btn-small" onClick={onRefresh} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button className="btn btn-secondary btn-small" onClick={onNew}>
            New intent
          </button>
        </div>
      </div>

      {error && <div className="error-banner" role="alert">{error}</div>}

      {loading && intents.length === 0 && (
        <p className="timeline-loading">Loading saved workflows…</p>
      )}

      {!loading && !error && intents.length === 0 && (
        <p className="history-empty">
          No saved workflows yet. Interpret an intent to create your first one.
        </p>
      )}

      {intents.length > 0 && (
        <ul className="history-list">
          {intents.map((savedIntent) => {
            const transaction = latestTransaction(transactions, savedIntent.id);
            const selected = savedIntent.id === selectedIntentId;
            return (
              <li key={savedIntent.id}>
                <button
                  type="button"
                  className={`history-item ${selected ? 'history-item--selected' : ''}`}
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => onSelect(savedIntent.id)}
                >
                  <span className="history-purpose">{savedIntent.structured.purpose}</span>
                  <span className="history-meta">
                    <span
                      className={`history-state ${
                        transaction?.financialState === 'PAYMENT_COMPLETED'
                          ? 'history-state--paid'
                          : transaction
                            ? 'history-state--pending'
                            : ''
                      }`}
                    >
                      {transactionStatusLabel(transaction)}
                    </span>
                    <span className="history-date">{formatHistoryDate(savedIntent.createdAt)}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
