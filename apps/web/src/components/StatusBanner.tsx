import { useEffect, useState } from 'react';
import { getHealth } from '../api';

type Status = 'checking' | 'connected' | 'unavailable';

export function StatusBanner() {
  const [status, setStatus] = useState<Status>('checking');

  useEffect(() => {
    let cancelled = false;
    getHealth()
      .then(() => {
        if (!cancelled) setStatus('connected');
      })
      .catch(() => {
        if (!cancelled) setStatus('unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dotClass =
    status === 'connected' ? 'status-dot--connected' : status === 'unavailable' ? 'status-dot--error' : 'status-dot--checking';

  return (
    <div className="status-banner" role="status" aria-live="polite">
      <span className={`status-dot ${dotClass}`} />
      <span className="status-label">
        API: {status === 'connected' ? 'Connected' : status === 'unavailable' ? 'Unavailable' : 'Checking'}
      </span>
    </div>
  );
}
