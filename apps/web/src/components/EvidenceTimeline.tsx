import { useState } from 'react';
import type { EvidenceRecord } from '@agentproof/shared';

interface Props {
  events: EvidenceRecord[];
  loading: boolean;
  error?: string | null;
}

function formatTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return ts;
  }
}

function eventCategory(eventType: string): string {
  if (eventType.includes('PAYPAL')) return 'paypal';
  if (eventType.includes('PAYMENT')) return 'payment';
  if (eventType.includes('INTENT')) return 'intent';
  if (eventType.includes('PRODUCT')) return 'product';
  if (eventType.includes('POLICY')) return 'policy';
  return 'default';
}

export function EvidenceTimeline({ events, loading, error }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="panel">
      <div className="panel-title-row">
        <h3 className="panel-title">Evidence Timeline</h3>
        {loading && <span className="timeline-inline-loading">Refreshing…</span>}
      </div>
      {error && <div className="error-banner" role="alert">{error}</div>}
      {loading && events.length === 0 && (
        <p className="timeline-loading">Loading evidence…</p>
      )}
      {!loading && !error && events.length === 0 && (
        <p className="timeline-empty">No evidence recorded yet.</p>
      )}
      {events.length > 0 && (
        <ol className="timeline">
          {events.map((ev) => {
            const isOpen = expanded.has(ev.id);
            const cat = eventCategory(ev.eventType);
            return (
              <li key={ev.id} className="timeline-item">
                <button
                  className="timeline-header"
                  onClick={() => toggle(ev.id)}
                  aria-expanded={isOpen}
                >
                  <span className={`timeline-dot timeline-dot--${cat}`} />
                  <span className="timeline-event-type">{ev.eventType}</span>
                  <span className="timeline-time">{formatTime(ev.timestamp)}</span>
                  <span className="timeline-actor">{ev.actor}</span>
                  <span className="timeline-toggle">{isOpen ? '−' : '+'}</span>
                </button>
                {isOpen && (
                  <div className="timeline-detail">
                    <dl className="timeline-meta">
                      <div><dt>Source</dt><dd>{ev.metadata.source}</dd></div>
                      {ev.intentId && <div><dt>Intent</dt><dd>{ev.intentId}</dd></div>}
                      {ev.transactionId && <div><dt>Transaction</dt><dd>{ev.transactionId}</dd></div>}
                      {ev.policyEvaluationId && <div><dt>Policy eval</dt><dd>{ev.policyEvaluationId}</dd></div>}
                    </dl>
                    <pre className="timeline-data">{JSON.stringify(ev.data, null, 2)}</pre>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
