import { useEffect, useState, useRef } from 'react';
import { useHashRoute, useSearchParams } from './router';
import { getTransactionByPaypalOrderId, capturePayment, ApiError } from './api';

type Status =
  | 'resolving'
  | 'verifying'
  | 'completed'
  | 'already_completed'
  | 'cancelled'
  | 'unconfirmed';

export function PaymentReturn() {
  const path = useHashRoute();
  const [params] = useSearchParams();
  const [status, setStatus] = useState<Status>('resolving');
  const [error, setError] = useState<string | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [workflowIntentId, setWorkflowIntentId] = useState<string | null>(null);
  const [evidenceIncomplete, setEvidenceIncomplete] = useState(false);
  const ranKey = useRef<string | null>(null);

  useEffect(() => {
    // Run once per distinct return URL. The key also prevents React StrictMode's
    // development double-invocation from issuing a second capture request.
    const key = `${path}?${params.toString()}`;
    if (ranKey.current === key) return;
    ranKey.current = key;

    setStatus('resolving');
    setError(null);
    setOrderId(null);
    setWorkflowIntentId(null);
    setEvidenceIncomplete(false);

    const token = params.get('token');
    const paypalStatus = params.get('status');

    if (path === '/payment/cancel' || paypalStatus === 'cancel') {
      setStatus('cancelled');
      return;
    }

    if (!token) {
      setStatus('unconfirmed');
      setError('Invalid payment return. No PayPal order token found.');
      return;
    }

    setOrderId(token);

    async function run() {
      try {
        const tx = await getTransactionByPaypalOrderId(token!);
        setWorkflowIntentId(tx.intentId);
        if (tx.financialState === 'PAYMENT_COMPLETED') {
          // Never report failure for an already-completed transaction. Retrying
          // capture is the bounded, idempotent place to reconcile evidence.
          try {
            const result = await capturePayment(tx.transactionId);
            setEvidenceIncomplete(Boolean(result.evidenceIncomplete));
          } catch {
            setEvidenceIncomplete(true);
          }
          setStatus('already_completed');
          return;
        }

        setStatus('verifying');
        const result = await capturePayment(tx.transactionId);
        if (result.financialState === 'PAYMENT_COMPLETED') {
          setEvidenceIncomplete(Boolean(result.evidenceIncomplete));
          setStatus('completed');
        } else {
          setStatus('unconfirmed');
          setError(
            'PayPal completion was not confirmed. The payment may still be pending; check the saved workflow before retrying.',
          );
        }
      } catch (err) {
        // A failed verification request is not proof of a failed payment.
        try {
          const latest = await getTransactionByPaypalOrderId(token!);
          setWorkflowIntentId(latest.intentId);
          if (latest.financialState === 'PAYMENT_COMPLETED') {
            setEvidenceIncomplete(true);
            setStatus('already_completed');
            return;
          }
        } catch {
          // Keep the informative uncertainty message below.
        }

        setStatus('unconfirmed');
        if (err instanceof ApiError) {
          if (err.status === 401) {
            setError('Your session has expired. Please sign in again.');
          } else if (err.status === 403) {
            setError('You do not have permission to verify this payment.');
          } else {
            const base = err.message.replace(/[.!?]$/, '');
            setError(
              `${base}. The payment outcome is not confirmed; check the saved workflow before retrying.`,
            );
          }
        } else {
          setError(
            'We could not verify the payment outcome. Check the saved workflow before retrying.',
          );
        }
      }
    }

    run();
  }, [params, path]);

  const returnHref = workflowIntentId
    ? `#/?intent=${encodeURIComponent(workflowIntentId)}`
    : '#/';
  const returnLabel = workflowIntentId ? 'View saved workflow' : 'Return to AgentProof';

  return (
    <div className="app">
      <main className="app-main">
        <div className="panel">
          <h2 className="panel-title">Payment Status</h2>

          {status === 'resolving' && (
            <p className="timeline-loading">Resolving payment…</p>
          )}

          {status === 'verifying' && (
            <p className="timeline-loading">Verifying with PayPal…</p>
          )}

          {status === 'completed' && (
            <div className="capture-result">
              <div className="capture-success">Payment completed</div>
              <p className="payment-hint">PayPal order: {orderId}</p>
              {evidenceIncomplete && (
                <p className="evidence-warning" role="status">
                  Payment was confirmed, but completion evidence is still being reconciled.
                  Open the saved workflow to check it again.
                </p>
              )}
              <a href={returnHref} className="btn btn-secondary">{returnLabel}</a>
            </div>
          )}

          {status === 'already_completed' && (
            <div className="capture-result">
              <div className="capture-success">Payment already completed</div>
              <p className="payment-hint">PayPal order: {orderId}</p>
              {evidenceIncomplete && (
                <p className="evidence-warning" role="status">
                  The payment is complete, but completion evidence is still being reconciled.
                  Open the saved workflow to check it again.
                </p>
              )}
              <a href={returnHref} className="btn btn-secondary">{returnLabel}</a>
            </div>
          )}

          {status === 'cancelled' && (
            <div>
              <p className="payment-hint">
                PayPal checkout was cancelled. This return flow did not capture a payment.
                Check the saved workflow if you are unsure about the final state.
              </p>
              <a href={returnHref} className="btn btn-secondary">{returnLabel}</a>
            </div>
          )}

          {status === 'unconfirmed' && (
            <div>
              <div className="evidence-warning" role="alert">
                {error ?? 'The payment outcome could not be confirmed.'}
              </div>
              <a href={returnHref} className="btn btn-secondary">{returnLabel}</a>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
