import { useEffect, useRef, useState } from 'react';
import type { CaptureResponse } from '../api';
import type { OfferSnapshotView, Product, Transaction } from '@agentproof/shared';
import { ApiError } from '../api';
import type { EvidenceCompleteness } from '../workflow';
import { paymentDisplay, transactionStatusLabel } from '../workflow';

interface Props {
  product: Product | null;
  /** Immutable snapshot for the current selection, used for its amount. */
  selectionSnapshot: OfferSnapshotView | null;
  /** Product recorded on the saved transaction; display-only, never a selection. */
  transactionProduct: Product | null;
  transaction: Transaction | null;
  evidenceCompleteness: EvidenceCompleteness;
  captureNotice: string | null;
  confirmationRequired: boolean;
  /** True only when a persisted selection allows a new order from this screen. */
  canStartOrder: boolean;
  orderBlockedReason: string | null;
  loading: boolean;
  error: string | null;
  onBuy: () => void;
  onCapture: (transactionId: string) => Promise<CaptureResponse>;
}

type CheckoutState = 'idle' | 'initializing' | 'ready' | 'approving' | 'completed' | 'cancelled' | 'error';

interface PayPalSDKInstance {
  findEligibleMethods(options?: { currencyCode?: string }): Promise<{
    isEligible(method: string): boolean;
  }>;
  createPayPalOneTimePaymentSession(options: {
    onApprove: (data: { orderId: string; payerId: string }) => Promise<void>;
    onCancel: (data: { orderId: string }) => void;
    onError: (error: { code: string; message: string }) => void;
    orderId?: string;
  }): {
    start(options?: { presentationMode?: string }, orderPromise?: Promise<unknown>): Promise<void>;
  };
}

declare global {
  interface Window {
    paypal?: {
      createInstance(options: { clientId: string; components?: string[] }): Promise<PayPalSDKInstance>;
    };
  }
}

function loadPayPalScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.paypal) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://www.sandbox.paypal.com/web-sdk/v6/core';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load PayPal SDK'));
    document.head.appendChild(script);
  });
}

export function PaymentPanel({
  product,
  selectionSnapshot,
  transactionProduct,
  transaction,
  evidenceCompleteness,
  captureNotice,
  confirmationRequired,
  canStartOrder,
  orderBlockedReason,
  loading,
  error,
  onBuy,
  onCapture,
}: Props) {
  const [checkoutState, setCheckoutState] = useState<CheckoutState>('idle');
  const [sdkError, setSdkError] = useState<string | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const buttonRef = useRef<HTMLElement | null>(null);
  const sessionRef = useRef<ReturnType<PayPalSDKInstance['createPayPalOneTimePaymentSession']> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    sessionRef.current = null;
    setCheckoutState('idle');
    setSdkError(null);
  }, [transaction?.id]);

  async function handleBuy() {
    if (!transaction?.paypalOrderId) return;
    setCheckoutState('initializing');
    setSdkError(null);

    try {
      await loadPayPalScript();
      if (!mountedRef.current) return;

      const clientId = import.meta.env.VITE_PAYPAL_CLIENT_ID as string | undefined;
      if (!clientId) {
        setCheckoutState('error');
        setSdkError('PayPal client ID is not configured.');
        return;
      }

      const sdk = await window.paypal!.createInstance({
        clientId,
        components: ['paypal-payments'],
      });
      if (!mountedRef.current) return;

      // The saved transaction owns its currency. A newer offer selection must
      // not change what is being approved for this PayPal order.
      const eligibility = await sdk.findEligibleMethods({ currencyCode: transaction.currency });
      if (!mountedRef.current) return;

      if (!eligibility.isEligible('paypal')) {
        setCheckoutState('error');
        setSdkError('PayPal is not available for this transaction.');
        return;
      }

      const session = sdk.createPayPalOneTimePaymentSession({
        orderId: transaction.paypalOrderId,
        onApprove: async () => {
          if (!mountedRef.current) return;
          setCheckoutState('approving');
          try {
            const result = await onCapture(transaction.id);
            if (!mountedRef.current) return;
            if (result.financialState === 'PAYMENT_COMPLETED') {
              setCheckoutState('completed');
            } else {
              setCheckoutState('error');
              setSdkError('Payment verification did not confirm completion.');
            }
          } catch (err) {
            if (!mountedRef.current) return;
            setCheckoutState('error');
            setSdkError(
              err instanceof ApiError
                ? err.message
                : 'Payment verification did not complete. Check the saved workflow before retrying.',
            );
          }
        },
        onCancel: () => {
          if (!mountedRef.current) return;
          setCheckoutState('cancelled');
        },
        onError: (err) => {
          if (!mountedRef.current) return;
          setCheckoutState('error');
          setSdkError(err.message || 'PayPal checkout error');
        },
      });

      sessionRef.current = session;
      if (!mountedRef.current) return;

      if (buttonRef.current) {
        buttonRef.current.removeAttribute('hidden');
        const handler = async () => {
          try {
            await session.start({ presentationMode: 'auto' });
          } catch (err) {
            if (!mountedRef.current) return;
            setCheckoutState('error');
            setSdkError(err instanceof Error ? err.message : 'Failed to start payment');
          }
        };
        buttonRef.current.addEventListener('click', handler, { once: true });
      }

      setCheckoutState('ready');
    } catch (err) {
      if (!mountedRef.current) return;
      setCheckoutState('error');
      setSdkError(err instanceof Error ? err.message : 'Failed to initialize PayPal checkout');
    }
  }

  async function handleReconcile() {
    if (!transaction) return;
    setReconciling(true);
    setSdkError(null);
    try {
      await onCapture(transaction.id);
    } catch (err) {
      setSdkError(
        err instanceof ApiError
          ? err.message
          : 'Evidence reconciliation did not complete. The saved payment state is unchanged.',
      );
    } finally {
      if (mountedRef.current) setReconciling(false);
    }
  }

  if (!product && !transaction) {
    return (
      <div className="panel">
        <h3 className="panel-title">Payment</h3>
        <p className="payment-empty">Choose an authorized product to continue.</p>
      </div>
    );
  }

  const completed = transaction?.financialState === 'PAYMENT_COMPLETED';
  const payable = transaction?.financialState === 'PAYMENT_PENDING' && transaction.paypalOrderId;
  const display = paymentDisplay({
    selectedProduct: product,
    selectedPrice: selectionSnapshot?.price ?? null,
    selectedCurrency: selectionSnapshot?.currency ?? null,
    transactionProduct,
    transaction,
  });
  const displayAmount = display ? `${display.amount} ${display.currency}` : '—';
  const displayProduct = display?.productName ?? '—';
  const selectionDiffersFromTransaction =
    product !== null && transaction !== null && product.id !== transaction.productId;

  return (
    <div className="panel">
      <h3 className="panel-title">Payment</h3>

      <div className="payment-summary">
        <div className="payment-row">
          <span>Product</span>
          <span className="payment-product-name">{displayProduct}</span>
        </div>
        <div className="payment-row">
          <span>Amount</span>
          <span>{displayAmount}</span>
        </div>
        {transaction && (
          <div className="payment-row">
            <span>Status</span>
            <span className={`badge ${completed ? 'badge--allow' : 'badge--pending'}`}>
              {transactionStatusLabel(transaction)}
            </span>
          </div>
        )}
        {confirmationRequired && (
          <div className="payment-row">
            <span>Confirmation</span>
            <span className="badge badge--confirm">Required</span>
          </div>
        )}
      </div>

      {selectionDiffersFromTransaction && (
        <p className="payment-hint">
          This payment belongs to the saved transaction shown above. It is separate from your
          current offer selection.
        </p>
      )}

      {(error || sdkError) && (
        <div className="error-banner" role="alert">{error || sdkError}</div>
      )}

      {captureNotice && (
        <p className="payment-notice" role="status">{captureNotice}</p>
      )}

      {!transaction && product && (
        <button
          className="btn btn-primary"
          onClick={onBuy}
          disabled={loading || !canStartOrder}
        >
          {loading ? 'Processing…' : 'Buy with PayPal'}
        </button>
      )}

      {!transaction && product && !canStartOrder && orderBlockedReason && (
        <p className="payment-hint">{orderBlockedReason}</p>
      )}

      {transaction?.financialState === 'PAYMENT_PENDING' && !transaction.paypalOrderId && (
        <p className="payment-hint">
          This saved transaction has no PayPal order, so it cannot be paid.
        </p>
      )}

      {payable && (
        <div className="payment-actions">
          <paypal-button ref={buttonRef as React.RefObject<HTMLElement>} hidden />
          {checkoutState === 'idle' && (
            <button className="btn btn-primary" onClick={handleBuy} disabled={loading}>
              {loading ? 'Processing…' : 'Pay with PayPal'}
            </button>
          )}
          {checkoutState === 'initializing' && (
            <p className="timeline-loading">Initializing PayPal checkout…</p>
          )}
          {checkoutState === 'ready' && (
            <p className="payment-hint">Click the PayPal button above to approve the payment.</p>
          )}
          {checkoutState === 'approving' && (
            <p className="timeline-loading">Verifying with PayPal…</p>
          )}
          {checkoutState === 'cancelled' && (
            <div>
              <p className="payment-hint">
                PayPal checkout was cancelled. No capture was requested. If you are unsure,
                check the saved workflow before trying again.
              </p>
              <button className="btn btn-secondary" onClick={handleBuy}>
                Try again
              </button>
            </div>
          )}
          {checkoutState === 'error' && (
            <div>
              <button className="btn btn-secondary" onClick={handleBuy}>
                Try again
              </button>
            </div>
          )}
        </div>
      )}

      {completed && transaction && (
        <div className="capture-result">
          <div className="capture-success">Payment completed</div>
          <dl className="capture-details">
            <div><dt>PayPal order</dt><dd>{transaction.paypalOrderId ?? '—'}</dd></div>
            <div><dt>Capture ID</dt><dd>{transaction.paypalCaptureId ?? '—'}</dd></div>
            <div><dt>Amount</dt><dd>{displayAmount}</dd></div>
            <div><dt>Recorded</dt><dd>{transaction.updatedAt}</dd></div>
          </dl>
          {evidenceCompleteness === 'incomplete' && (
            <div className="evidence-warning" role="alert">
              <p>
                Payment was confirmed by PayPal, but completion evidence is incomplete.
                It is safe to reconcile this record again.
              </p>
              <button
                className="btn btn-secondary btn-small"
                onClick={handleReconcile}
                disabled={reconciling}
              >
                {reconciling ? 'Checking evidence…' : 'Check evidence again'}
              </button>
            </div>
          )}
          {evidenceCompleteness === 'complete' && (
            <p className="payment-hint">Completion evidence is present in the timeline.</p>
          )}
        </div>
      )}
    </div>
  );
}
