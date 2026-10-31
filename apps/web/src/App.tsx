import { useState, useCallback, useEffect, useRef } from 'react';
import type {
  StructuredIntent,
  Product,
  EvidenceRecord,
  Transaction,
} from '@agentproof/shared';
import {
  createIntent,
  discoverProducts,
  getDiscoveries,
  getActiveSelection,
  createSelection,
  createOrder,
  capturePayment,
  getIntent,
  listIntents,
  listTransactions,
  getEvidenceByIntent,
  getSession,
  login,
  logout,
  requestRetailerHandoff,
  setSessionExpiredHandler,
  register,
  ApiError,
  type AuthUser,
  type IntentResponse,
  type DiscoverResponse,
  type DiscoverCandidate,
  type CaptureResponse,
} from './api';
import { useHashRoute, useSearchParams } from './router';
import { StatusBanner } from './components/StatusBanner';
import { LoginScreen } from './components/LoginScreen';
import { IntentInput } from './components/IntentInput';
import { StructuredIntentView } from './components/StructuredIntentView';
import { CandidateCard } from './components/CandidateCard';
import { PaymentPanel } from './components/PaymentPanel';
import { RetailerHandoff } from './components/RetailerHandoff';
import { EvidenceTimeline } from './components/EvidenceTimeline';
import { WorkflowHistory } from './components/WorkflowHistory';
import { PaymentReturn } from './PaymentReturn';
import { isSafeRetailerNavigationUrl, handoffOfferMatches, offerForCandidate } from './handoff';
import {
  canStartNewOrder,
  candidateOfferRef,
  candidateSelectionState,
  createIdleSelectionState,
  createInitialSelectionState,
  productOfferRef,
  reduceSelection,
  resolveSelection,
  selectionMatchesCandidate,
  staleSelectionMessage,
  type SelectionState,
} from './selection';
import {
  evidenceCompleteness as calculateEvidenceCompleteness,
  latestSafeTransaction,
  latestTransaction,
  mergeTransactions,
  pendingTransactionFromOrder,
  productForTransaction,
  safeTransactionById,
} from './workflow';

// ── Flow stages ─────────────────────────────────────────────────────────────

const STAGES = [
  { id: 'intent', label: 'Intent' },
  { id: 'policy', label: 'Policy' },
  { id: 'product', label: 'Product' },
  { id: 'payment', label: 'Payment' },
  { id: 'verify', label: 'Verify' },
  { id: 'evidence', label: 'Evidence' },
] as const;

/**
 * A restored discovery is display-only and never supplies a fresh fallback
 * recommendation. Keep this derivation identical between full workflow restore
 * and focus/manual refresh.
 */
function restoredDiscovery(response: DiscoverResponse): DiscoverResponse | null {
  return response.candidates.length > 0 ||
    response.allowed.length > 0 ||
    response.rejected.length > 0 ||
    (response.missingEvaluations ?? 0) > 0
    ? { ...response, restored: true }
    : null;
}

type StageId = (typeof STAGES)[number]['id'];

function deriveStage(params: {
  intent: IntentResponse | null;
  discover: DiscoverResponse | null;
  transaction: Transaction | null;
  selectedProduct: Product | null;
}): StageId {
  if (params.transaction?.financialState === 'PAYMENT_COMPLETED') return 'evidence';
  if (params.transaction) return 'verify';
  if (params.selectedProduct) return 'payment';
  if (params.discover) return 'product';
  if (params.intent) return 'policy';
  return 'intent';
}

/** User-facing message for an API failure, including explicit 403 handling. */
function apiErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Your session has expired. Please sign in again.';
    if (err.status === 403) return 'You do not have permission to perform this action.';
    return err.message;
  }
  return fallback;
}

// ── Auth state ──────────────────────────────────────────────────────────────

type AuthState =
  | { status: 'checking' }
  | { status: 'unauthenticated' }
  | { status: 'authenticated'; user: AuthUser };

// ── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  const path = useHashRoute();
  const [auth, setAuth] = useState<AuthState>({ status: 'checking' });
  const [notice, setNotice] = useState<string | null>(null);

  // Resolve the HttpOnly cookie session once on load.
  useEffect(() => {
    let cancelled = false;
    getSession()
      .then((session) => {
        if (!cancelled) setAuth({ status: 'authenticated', user: session.user });
      })
      .catch(() => {
        if (!cancelled) setAuth({ status: 'unauthenticated' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A 401 from any authenticated request means the cookie session is gone or
  // expired; return to the sign-in screen instead of leaving stale UI.
  useEffect(() => {
    setSessionExpiredHandler(() => {
      setAuth({ status: 'unauthenticated' });
      setNotice('Your session has expired. Please sign in again.');
    });
    return () => setSessionExpiredHandler(null);
  }, []);

  async function handleLogin(email: string, password: string): Promise<void> {
    const session = await login(email, password);
    setNotice(null);
    setAuth({ status: 'authenticated', user: session.user });
  }

  async function handleRegister(email: string, password: string): Promise<void> {
    const response = await register(email, password);
    setNotice('Registration successful. You can now sign in.');
    setAuth({ status: 'authenticated', user: response.user });
  }

  async function handleLogout(): Promise<void> {
    try {
      await logout();
    } finally {
      setNotice(null);
      setAuth({ status: 'unauthenticated' });
    }
  }

  if (auth.status === 'checking') {
    return (
      <div className="app">
        <main className="app-main">
          <p className="timeline-loading">Checking session…</p>
        </main>
      </div>
    );
  }

  if (auth.status === 'unauthenticated') {
    return <LoginScreen onLogin={handleLogin} onRegister={handleRegister} notice={notice} />;
  }

  if (path === '/payment/return' || path === '/payment/cancel') {
    return <PaymentReturn />;
  }

  return <MainApp user={auth.user} onLogout={handleLogout} />;
}

function MainApp({ user, onLogout }: { user: AuthUser; onLogout: () => Promise<void> }) {
  const [params] = useSearchParams();
  const routeIntentId = params.get('intent');

  const [intents, setIntents] = useState<IntentResponse[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const [intent, setIntent] = useState<IntentResponse | null>(null);
  const [discover, setDiscover] = useState<DiscoverResponse | null>(null);
  const [transaction, setTransaction] = useState<Transaction | null>(null);
  const [selectionState, setSelectionState] =
    useState<SelectionState>(createInitialSelectionState);
  const [handoffLoading, setHandoffLoading] = useState(false);
  const [handoffError, setHandoffError] = useState<string | null>(null);

  const [evidence, setEvidence] = useState<EvidenceRecord[]>([]);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);

  const [workflowLoading, setWorkflowLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [flowError, setFlowError] = useState<string | null>(null);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [captureNotice, setCaptureNotice] = useState<string | null>(null);
  const [captureEvidenceIncomplete, setCaptureEvidenceIncomplete] = useState(false);

  const loadingIntentRef = useRef<string | null>(null);
  const failedIntentRef = useRef<string | null>(null);
  // The intent currently owned by this mounted workflow. Async actions check it
  // before writing state so a slow request cannot bleed into a newly selected
  // saved workflow.
  const activeIntentRef = useRef<string | null>(null);
  const routeIntentRef = useRef(routeIntentId);
  routeIntentRef.current = routeIntentId;
  const intentCreateRef = useRef(0);
  // Monotonic ids for selection reads and writes. Responses older than the
  // newest started request are ignored so they cannot overwrite newer state.
  const selectionRequestRef = useRef(0);
  // Every workflow state writer shares a monotonic generation. A slower restore
  // or refresh from an older generation must not overwrite newer state.
  const workflowEpochRef = useRef(0);
  const workflowLoadRef = useRef(0);
  const evidenceRequestRef = useRef(0);
  const transactionRequestRef = useRef(0);
  const discoveryRequestRef = useRef(0);
  const historyRequestRef = useRef(0);
  const selectionWriteRef = useRef(false);
  // Selection reads, revalidation, discovery, and saves all invalidate the Buy
  // action while in flight. The count supports nested refresh work; the allowed
  // ref is a synchronous fail-closed guard for stale event handlers.
  const selectionWorkCountRef = useRef(0);
  const buyAllowedRef = useRef(false);
  const transactionsRef = useRef<Transaction[]>([]);
  const transactionRef = useRef<Transaction | null>(null);

  const beginSelectionWork = useCallback(() => {
    selectionWorkCountRef.current += 1;
    buyAllowedRef.current = false;
  }, []);

  const endSelectionWork = useCallback(() => {
    selectionWorkCountRef.current = Math.max(0, selectionWorkCountRef.current - 1);
  }, []);

  const mergeIntoHistory = useCallback((incoming: Transaction[]): Transaction[] => {
    const next = mergeTransactions(transactionsRef.current, incoming);
    transactionsRef.current = next;
    setTransactions(next);
    return next;
  }, []);

  const commitTransaction = useCallback((next: Transaction | null) => {
    transactionRef.current = next;
    setTransaction(next);
  }, []);

  const updateTransaction = useCallback(
    (update: (previous: Transaction | null) => Transaction | null) => {
      const next = update(transactionRef.current);
      transactionRef.current = next;
      setTransaction(next);
    },
    [],
  );

  const recommendationRef = discover?.selectedProduct
    ? productOfferRef(discover.selectedProduct)
    : null;
  // The first authorized option is an automatic fallback only for a fresh,
  // allowed discovery with no recommendation. A restored workflow or a denied
  // discovery never invents a choice.
  const fallbackRef =
    discover && !discover.restored && discover.decision === 'ALLOW' && !discover.selectedProduct
      ? discover.allowed[0]
        ? candidateOfferRef(discover.allowed[0])
        : null
      : null;
  const selection = resolveSelection({
    candidates: discover?.candidates ?? [],
    state: selectionState,
    recommendation: recommendationRef,
    fallback: fallbackRef,
  });
  const selectedCandidate = selection.candidate;
  const selectedProduct = selectedCandidate?.product ?? null;
  const selectedSnapshot = offerForCandidate(selectedCandidate);
  // The saved transaction resolves its own product for display only. It is
  // never promoted to the current offer selection.
  const transactionProduct = productForTransaction(discover, transaction);
  const handoffEnabled = discover?.handoffEnabled === true;
  const handoffEligible = selectedCandidate?.handoffEligible === true;
  const canStartOrder = canStartNewOrder(selection, selectionState);
  // Keep the synchronous guard aligned with the latest rendered state. It stays
  // false while any selection read, save, or revalidation owns the workflow.
  buyAllowedRef.current = canStartOrder && selectionWorkCountRef.current === 0;
  const orderBlockedReason = (() => {
    if (canStartOrder) return null;
    if (selectionState.status === 'unresolved') {
      return 'Checking your saved selection before enabling payment…';
    }
    if (selectionState.status === 'pending') {
      return 'Saving your selection before enabling payment…';
    }
    if (selectionState.status === 'error') {
      return 'Your saved selection could not be confirmed. Refresh the workflow or choose an offer again.';
    }
    if (selection.staleReason) return staleSelectionMessage(selection.staleReason);
    return 'Select an offer to record your choice before starting a payment.';
  })();
  const stage = deriveStage({ intent, discover, transaction, selectedProduct });
  // A failed evidence read is not evidence that records are missing. Only show
  // an incomplete state from the authoritative backend signal or successfully
  // loaded records.
  const completeness = captureEvidenceIncomplete
    ? 'incomplete'
    : evidenceLoading || evidenceError
      ? null
      : calculateEvidenceCompleteness(transaction, evidence);

  const resetWorkflow = useCallback(() => {
    setIntent(null);
    setDiscover(null);
    commitTransaction(null);
    setSelectionState(createInitialSelectionState());
    selectionWriteRef.current = false;
    buyAllowedRef.current = false;
    setEvidence([]);
    setEvidenceLoading(false);
    setEvidenceError(null);
    setActionLoading(false);
    setFlowError(null);
    setWorkflowError(null);
    setPaymentError(null);
    setCaptureNotice(null);
    setCaptureEvidenceIncomplete(false);
    setHandoffLoading(false);
    setHandoffError(null);
  }, [commitTransaction]);

  const loadHistory = useCallback(async () => {
    const requestId = ++historyRequestRef.current;
    const isCurrent = () => historyRequestRef.current === requestId;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const [savedIntents, savedTransactions] = await Promise.all([
        listIntents(25),
        listTransactions(undefined, 50),
      ]);
      // The global transaction merge is monotonic, but an older intent list
      // must not replace a newer history response.
      mergeIntoHistory(savedTransactions);
      if (!isCurrent()) return;
      setIntents(savedIntents);
    } catch (err) {
      if (isCurrent()) setHistoryError(apiErrorMessage(err, 'Failed to load saved workflows'));
    } finally {
      if (isCurrent()) setHistoryLoading(false);
    }
  }, [mergeIntoHistory]);

  const refreshEvidence = useCallback(async (intentId: string) => {
    if (activeIntentRef.current !== intentId) return;
    const epoch = workflowEpochRef.current;
    const requestId = ++evidenceRequestRef.current;
    const isCurrent = () =>
      activeIntentRef.current === intentId &&
      workflowEpochRef.current === epoch &&
      evidenceRequestRef.current === requestId;

    setEvidenceLoading(true);
    setEvidenceError(null);
    try {
      const records = await getEvidenceByIntent(intentId);
      if (!isCurrent()) return;
      setEvidence(records);
      // The fetched records are now authoritative; a capture-time warning is no
      // longer needed (and would be misleading if recovery has since succeeded).
      setCaptureEvidenceIncomplete(false);
    } catch (err) {
      if (!isCurrent()) return;
      setEvidenceError(apiErrorMessage(err, 'Failed to load evidence'));
    } finally {
      if (isCurrent()) setEvidenceLoading(false);
    }
  }, []);

  const refreshTransactions = useCallback(
    async (intentId: string, transactionId?: string): Promise<Transaction | null> => {
      const epoch = workflowEpochRef.current;
      const requestId = ++transactionRequestRef.current;
      const refreshed = await listTransactions(intentId, 25);
      // The global history is always safe to merge, but the per-workflow panel
      // must not switch to a transaction from a superseded intent or an older
      // response.
      const mergedHistory = mergeIntoHistory(refreshed);
      if (
        activeIntentRef.current !== intentId ||
        workflowEpochRef.current !== epoch ||
        transactionRequestRef.current !== requestId
      ) {
        return transactionRef.current;
      }
      // Capture recovery names the transaction it is recovering. Other callers
      // keep the newest-safe behavior for the whole intent.
      const target = transactionId
        ? safeTransactionById(transactionRef.current, mergedHistory, transactionId)
        : latestSafeTransaction(transactionRef.current, mergedHistory, intentId);
      if (target) commitTransaction(target);
      return target;
    },
    [commitTransaction, mergeIntoHistory],
  );

  const loadWorkflow = useCallback(
    async (intentId: string) => {
      const epoch = ++workflowEpochRef.current;
      const loadId = ++workflowLoadRef.current;
      loadingIntentRef.current = intentId;
      activeIntentRef.current = intentId;
      const isCurrent = () =>
        activeIntentRef.current === intentId &&
        routeIntentRef.current === intentId &&
        workflowEpochRef.current === epoch &&
        workflowLoadRef.current === loadId;

      // Clear the previous workflow immediately. The loading ref above prevents
      // the intent-id change from scheduling a duplicate restore.
      beginSelectionWork();
      resetWorkflow();
      setWorkflowLoading(true);

      const selectionRequestId = ++selectionRequestRef.current;
      setSelectionState((prev) =>
        reduceSelection(prev, { type: 'readStarted', requestId: selectionRequestId }),
      );

      try {
        // Evidence and selection are loaded independently: a failure in either
        // must not prevent the user from seeing the persisted intent, offers,
        // or payment, and must not invent a selection.
        const [
          savedIntent,
          savedDiscover,
          savedTransactions,
          savedEvidence,
          savedSelection,
        ] = await Promise.all([
          getIntent(intentId),
          getDiscoveries(intentId),
          listTransactions(intentId, 25),
          getEvidenceByIntent(intentId).then(
            (records) => ({ records, error: null as unknown }),
            (error: unknown) => ({ records: null, error }),
          ),
          getActiveSelection(intentId).then(
            (response) => ({ selection: response.selection, error: null as unknown }),
            (error: unknown) => ({ selection: null, error }),
          ),
        ]);
        // A newer restore, refresh, or browser navigation back to the root route
        // superseded this request while it was in flight.
        if (!isCurrent()) return;

        setIntent(savedIntent);
        setDiscover(restoredDiscovery(savedDiscover));
        const mergedHistory = mergeIntoHistory(savedTransactions);
        commitTransaction(latestTransaction(mergedHistory, intentId));
        // The saved transaction's product is resolved separately for display.
        // Only the selection endpoint may restore a user selection.
        if (savedSelection.error) {
          setSelectionState((prev) =>
            reduceSelection(prev, {
              type: 'readFailed',
              requestId: selectionRequestId,
              message: apiErrorMessage(savedSelection.error, 'Failed to load your saved selection'),
            }),
          );
        } else {
          setSelectionState((prev) =>
            reduceSelection(prev, {
              type: 'readSucceeded',
              requestId: selectionRequestId,
              selection: savedSelection.selection,
            }),
          );
        }
        if (savedEvidence.error) {
          setEvidence([]);
          setEvidenceError(apiErrorMessage(savedEvidence.error, 'Failed to load evidence'));
        } else {
          setEvidence(savedEvidence.records ?? []);
          setEvidenceError(null);
        }
        failedIntentRef.current = null;
      } catch (err) {
        if (!isCurrent()) return;
        activeIntentRef.current = null;
        if (err instanceof ApiError && err.status === 404) {
          failedIntentRef.current = intentId;
          resetWorkflow();
          setWorkflowError('That saved workflow was not found for your account.');
        } else {
          setWorkflowError(apiErrorMessage(err, 'Failed to restore the saved workflow'));
        }
      } finally {
        endSelectionWork();
        if (
          workflowLoadRef.current === loadId &&
          workflowEpochRef.current === epoch &&
          loadingIntentRef.current === intentId
        ) {
          loadingIntentRef.current = null;
          if (routeIntentRef.current !== intentId) activeIntentRef.current = null;
          setWorkflowLoading(false);
        }
      }
    },
    [beginSelectionWork, commitTransaction, endSelectionWork, mergeIntoHistory, resetWorkflow],
  );

  /**
   * Re-read the active selection and its current candidates without performing a
   * full workflow restore. Any failure is reported as an unresolved selection so
   * the payment action fails closed instead of trusting cached state.
   */
  const refreshWorkflowSnapshot = useCallback(async (intentId: string) => {
    if (activeIntentRef.current !== intentId || routeIntentRef.current !== intentId) return;
    if (loadingIntentRef.current === intentId || selectionWriteRef.current) return;

    const epoch = workflowEpochRef.current;
    const loadId = workflowLoadRef.current;
    const requestId = ++selectionRequestRef.current;
    const isCurrent = () =>
      activeIntentRef.current === intentId &&
      routeIntentRef.current === intentId &&
      workflowEpochRef.current === epoch &&
      workflowLoadRef.current === loadId &&
      selectionRequestRef.current === requestId;

    beginSelectionWork();
    setSelectionState((prev) =>
      reduceSelection(prev, { type: 'readStarted', requestId }),
    );

    try {
      const [savedDiscover, savedSelection] = await Promise.all([
        getDiscoveries(intentId),
        getActiveSelection(intentId),
      ]);
      if (!isCurrent()) return;
      setDiscover(restoredDiscovery(savedDiscover));
      setSelectionState((prev) =>
        reduceSelection(prev, {
          type: 'readSucceeded',
          requestId,
          selection: savedSelection.selection,
        }),
      );
    } catch (err) {
      if (!isCurrent()) return;
      setSelectionState((prev) =>
        reduceSelection(prev, {
          type: 'readFailed',
          requestId,
          message: apiErrorMessage(err, 'Failed to refresh your saved selection'),
        }),
      );
    } finally {
      endSelectionWork();
    }
  }, [beginSelectionWork, endSelectionWork]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    if (!routeIntentId) return;
    if (intent?.id === routeIntentId) return;
    if (loadingIntentRef.current === routeIntentId) return;
    if (failedIntentRef.current === routeIntentId) return;
    void loadWorkflow(routeIntentId);
  }, [routeIntentId, intent?.id, loadWorkflow]);

  // When the workflow regains focus (for example after another tab changed the
  // selection), re-read the selection and current candidates. A hidden tab does
  // not trigger a refresh.
  useEffect(() => {
    const intentId = intent?.id;
    if (!intentId || intentId !== routeIntentId) return;

    const refreshIfVisible = () => {
      if (document.visibilityState === 'hidden') return;
      void refreshWorkflowSnapshot(intentId);
    };
    window.addEventListener('focus', refreshIfVisible);
    document.addEventListener('visibilitychange', refreshIfVisible);
    return () => {
      window.removeEventListener('focus', refreshIfVisible);
      document.removeEventListener('visibilitychange', refreshIfVisible);
    };
  }, [intent?.id, routeIntentId, refreshWorkflowSnapshot]);

  // Leaving a workflow URL (for example with the browser Back button) must
  // discard the displayed workflow so the root route shows the intent form.
  // Intent creation updates the route before setting state, so this cannot race
  // with a newly created intent.
  useEffect(() => {
    if (routeIntentId) return;
    if (!intent && !discover && !transaction && !selectedProduct && evidence.length === 0) return;
    workflowEpochRef.current += 1;
    workflowLoadRef.current += 1;
    loadingIntentRef.current = null;
    activeIntentRef.current = null;
    failedIntentRef.current = null;
    setWorkflowLoading(false);
    resetWorkflow();
  }, [routeIntentId, intent, discover, transaction, selectedProduct, evidence.length, resetWorkflow]);

  async function handleRefresh() {
    beginSelectionWork();
    try {
      await loadHistory();
      if (intent) {
        const intentId = intent.id;
        // A restore already in flight owns the workflow state; refreshing slices
        // underneath it could let an older restore overwrite a newer read.
        if (loadingIntentRef.current === intentId) return;
        try {
          await refreshTransactions(intentId);
        } catch (err) {
          if (activeIntentRef.current === intentId) {
            setPaymentError(apiErrorMessage(err, 'Failed to refresh the saved transaction'));
          }
        }
        await refreshWorkflowSnapshot(intentId);
        await refreshEvidence(intentId);
      }
    } finally {
      endSelectionWork();
    }
  }

  function handleSelectWorkflow(intentId: string) {
    if (intentId === intent?.id) return;
    intentCreateRef.current += 1;
    failedIntentRef.current = null;
    if (routeIntentId === intentId) {
      // Retry a direct-link restore that previously failed without waiting for
      // another hashchange (the URL already points at this intent).
      void loadWorkflow(intentId);
    } else {
      // The route effect owns the load. Changing the hash first avoids loading
      // the old route when local state is cleared.
      workflowEpochRef.current += 1;
      workflowLoadRef.current += 1;
      loadingIntentRef.current = null;
      activeIntentRef.current = null;
      window.location.hash = `#/?intent=${encodeURIComponent(intentId)}`;
    }
  }

  function handleNewWorkflow() {
    intentCreateRef.current += 1;
    failedIntentRef.current = null;
    workflowEpochRef.current += 1;
    workflowLoadRef.current += 1;
    loadingIntentRef.current = null;
    activeIntentRef.current = null;

    const targetHash = '#/';
    if (window.location.hash !== targetHash || window.location.search) {
      // Update the route before clearing state so the route effect cannot see
      // the old intent URL with the new empty state and start restoring it.
      // replaceState alone does not notify the hash router, so dispatch the
      // change explicitly.
      window.history.replaceState(null, '', `${window.location.pathname}${targetHash}`);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    }

    setWorkflowLoading(false);
    resetWorkflow();
    setFlowError(null);
  }

  async function handleIntentSubmit(rawInput: string) {
    const requestId = ++intentCreateRef.current;
    beginSelectionWork();
    workflowEpochRef.current += 1;
    workflowLoadRef.current += 1;
    loadingIntentRef.current = null;
    activeIntentRef.current = null;
    selectionWriteRef.current = false;
    setWorkflowLoading(false);
    setActionLoading(true);
    setFlowError(null);
    setWorkflowError(null);
    setPaymentError(null);
    try {
      const result = await createIntent(rawInput);
      if (requestId !== intentCreateRef.current || activeIntentRef.current !== null) {
        // The user opened a saved workflow or started a new one while intent
        // parsing was in flight. Keep that selection and surface the new intent
        // through history.
        void loadHistory();
        return;
      }
      // Update the route before setting the new workflow state. This keeps the
      // root-route cleanup effect from immediately discarding a new intent.
      const nextHash = `#/?intent=${encodeURIComponent(result.id)}`;
      if (window.location.hash !== nextHash || window.location.search) {
        window.history.replaceState(null, '', `${window.location.pathname}${nextHash}`);
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      }
      failedIntentRef.current = null;
      activeIntentRef.current = result.id;
      setIntent(result);
      setDiscover(null);
      commitTransaction(null);
      // A new intent cannot have a persisted selection yet, so the state is
      // resolved-empty rather than unknown.
      setSelectionState(createIdleSelectionState());
      setEvidence([]);
      setEvidenceError(null);
      setCaptureNotice(null);
      setCaptureEvidenceIncomplete(false);
      setHandoffError(null);
      setHandoffLoading(false);
      await refreshEvidence(result.id);
      await loadHistory();
    } catch (err) {
      if (requestId === intentCreateRef.current && activeIntentRef.current === null) {
        setFlowError(apiErrorMessage(err, 'Failed to interpret intent'));
      }
    } finally {
      endSelectionWork();
      if (requestId === intentCreateRef.current) setActionLoading(false);
    }
  }

  async function handleDiscover() {
    if (!intent) return;
    if (selectionWriteRef.current || selectionWorkCountRef.current > 0) {
      // A discovery refresh during a selection write or revalidation could
      // append a newer snapshot while the user's click/read is still settling.
      // Let that work finish first; the exact-snapshot contract would still bind
      // the clicked row, but preventing the overlap keeps the displayed offer
      // stable.
      setFlowError(
        'A selection check or save is still in progress. Wait for it to finish before refreshing discovery.',
      );
      return;
    }
    const intentId = intent.id;
    const epoch = workflowEpochRef.current;
    const requestId = ++discoveryRequestRef.current;
    const isCurrent = () =>
      activeIntentRef.current === intentId &&
      workflowEpochRef.current === epoch &&
      discoveryRequestRef.current === requestId;

    beginSelectionWork();
    setActionLoading(true);
    setFlowError(null);
    setHandoffError(null);
    try {
      const result = await discoverProducts(intentId);
      if (!isCurrent()) return;
      // Recommendations and fallbacks are derived from this response and are
      // never persisted as the user's choice.
      setDiscover(result);
      await refreshEvidence(intentId);
    } catch (err) {
      if (isCurrent()) {
        setFlowError(apiErrorMessage(err, 'Failed to discover products'));
      }
    } finally {
      endSelectionWork();
      if (isCurrent()) setActionLoading(false);
    }
  }

  async function handleSelectProduct(candidate: DiscoverCandidate) {
    const intentId = intent?.id;
    if (!intentId || activeIntentRef.current !== intentId) return;
    const snapshot = candidate.snapshot;
    if (!snapshot || candidate.snapshotFresh !== true) {
      setFlowError(
        'This offer is no longer fresh or has no immutable snapshot. Re-run discovery and select it again.',
      );
      return;
    }
    const requestId = ++selectionRequestRef.current;
    beginSelectionWork();
    selectionWriteRef.current = true;
    setHandoffError(null);
    setPaymentError(null);
    setFlowError(null);
    // The clicked offer is locally pending, not saved, until the server
    // confirms the exact snapshot write. A stale or conflicting response leaves
    // the previous confirmed selection untouched and never substitutes another
    // offer.
    setSelectionState((prev) =>
      reduceSelection(prev, {
        type: 'saveStarted',
        requestId,
        ref: candidateOfferRef(candidate),
      }),
    );

    try {
      const response = await createSelection(
        intentId,
        candidate.product.source,
        candidate.product.id,
        snapshot.id,
      );
      if (activeIntentRef.current !== intentId) return;
      if (!selectionMatchesCandidate(response.selection, candidate)) {
        setSelectionState((prev) =>
          reduceSelection(prev, {
            type: 'saveFailed',
            requestId,
            message:
              'The saved selection did not match the offer you chose. Refresh the workflow before starting a payment.',
          }),
        );
        return;
      }
      setSelectionState((prev) =>
        reduceSelection(prev, {
          type: 'saveSucceeded',
          requestId,
          selection: response.selection,
          evidenceRecorded: response.evidenceRecorded,
          evidenceError: response.evidenceError ?? null,
        }),
      );
    } catch (err) {
      if (activeIntentRef.current !== intentId) return;
      setSelectionState((prev) =>
        reduceSelection(prev, {
          type: 'saveFailed',
          requestId,
          message: apiErrorMessage(err, 'Failed to save your selection'),
        }),
      );
    } finally {
      // A newer save owns the flag when this response is superseded.
      if (selectionRequestRef.current === requestId) {
        selectionWriteRef.current = false;
      }
      endSelectionWork();
    }
  }

  async function handleContinueToRetailer() {
    if (!intent || !selectedProduct || !selectedSnapshot || !handoffEnabled || !handoffEligible) return;
    const intentId = intent.id;
    const expectedSnapshot = selectedSnapshot;
    const selectionRequestId = selectionRequestRef.current;
    setHandoffLoading(true);
    setHandoffError(null);

    try {
      const result = await requestRetailerHandoff(intentId, expectedSnapshot);
      if (
        activeIntentRef.current !== intentId ||
        selectionRequestRef.current !== selectionRequestId
      ) {
        return;
      }
      if (!handoffOfferMatches(expectedSnapshot, result.offer)) {
        setHandoffError(
          'The retailer link did not match the offer you selected. Refresh the workflow and try again.',
        );
        return;
      }
      if (!isSafeRetailerNavigationUrl(result.url)) {
        setHandoffError('The retailer link returned by the server was not safe to open.');
        return;
      }
      // Explicit navigation only. Opening the retailer does not complete a
      // purchase inside AgentProof, and the app records no purchase claim.
      window.location.assign(result.url);
    } catch (err) {
      if (
        activeIntentRef.current === intentId &&
        selectionRequestRef.current === selectionRequestId
      ) {
        setHandoffError(apiErrorMessage(err, 'Failed to prepare the retailer link'));
      }
    } finally {
      if (activeIntentRef.current === intentId) setHandoffLoading(false);
    }
  }

  async function handleBuy() {
    if (!intent || !selectedProduct) return;
    const intentId = intent.id;
    if (activeIntentRef.current !== intentId) return;
    if (
      !canStartOrder ||
      selectionWorkCountRef.current > 0 ||
      !buyAllowedRef.current
    ) {
      // Defense in depth: the button is disabled, but a stale handler must not
      // start an order from a recommendation, pending choice, failed read, or a
      // selection/revalidation that is currently in flight.
      setPaymentError(
        orderBlockedReason ?? 'Select an offer to record your choice before starting a payment.',
      );
      return;
    }
    // Fail closed immediately; a render will re-enable it only when the latest
    // resolved selection is still valid.
    buyAllowedRef.current = false;
    setActionLoading(true);
    setPaymentError(null);
    setCaptureNotice(null);
    setCaptureEvidenceIncomplete(false);

    let orderCreated = false;
    try {
      const result = await createOrder(intentId, selectedProduct.id, true);
      if (activeIntentRef.current !== intentId) {
        // The workflow was switched while PayPal order creation was in flight.
        // Keep the new UI untouched; surface the new row through global history.
        void loadHistory();
        setActionLoading(false);
        return;
      }
      const pending = pendingTransactionFromOrder(intentId, selectedProduct, result);
      commitTransaction(pending);
      mergeIntoHistory([pending]);
      orderCreated = true;
    } catch (err) {
      if (activeIntentRef.current === intentId) {
        setPaymentError(apiErrorMessage(err, 'Failed to create payment order'));
      }
      setActionLoading(false);
      return;
    }

    if (orderCreated) {
      try {
        await refreshTransactions(intentId);
      } catch {
        if (activeIntentRef.current === intentId) {
          setCaptureNotice(
            'The order was created, but saved history could not be refreshed. Reload to confirm its authoritative state.',
          );
        }
      }
      await refreshEvidence(intentId);
      await loadHistory();
    }
    setActionLoading(false);
  }

  async function handleCapture(transactionId: string): Promise<CaptureResponse> {
    const intentId = transaction?.intentId ?? intent?.id ?? null;
    const isActive = () => intentId !== null && activeIntentRef.current === intentId;

    if (isActive()) setActionLoading(true);
    setPaymentError(null);
    setCaptureNotice(null);

    try {
      let result: CaptureResponse;
      try {
        result = await capturePayment(transactionId);
      } catch (err) {
        // Before reporting uncertainty, check whether the persisted record was
        // already completed by this or an overlapping capture.
        if (intentId && isActive()) {
          try {
            // Recovery is specific to the transaction being captured. A newer
            // completed transaction for the same intent is not this result.
            const recovered = await refreshTransactions(intentId, transactionId);
            if (
              recovered?.id === transactionId &&
              recovered.financialState === 'PAYMENT_COMPLETED'
            ) {
              await refreshEvidence(intentId);
              if (isActive()) {
                setCaptureNotice(
                  'PayPal verification returned an error, but this saved transaction is recorded as completed. AgentProof will re-check the completion evidence.',
                );
              }
              return {
                transactionId: recovered.id,
                financialState: 'PAYMENT_COMPLETED',
                reconciled: false,
              };
            }
          } catch {
            // Fall through to the user-facing uncertainty message below.
          }
        }

        const base = apiErrorMessage(err, 'We could not verify PayPal completion.');
        const message = `${base.replace(/[.!?]$/, '')}. The payment outcome is not confirmed; check the saved workflow before retrying.`;
        if (isActive()) setPaymentError(message);
        throw new ApiError(message, err instanceof ApiError ? err.status : 0);
      }

      if (result.financialState !== 'PAYMENT_COMPLETED') {
        const message = 'Payment verification did not confirm completion.';
        if (isActive()) setPaymentError(message);
        throw new ApiError(message, 502);
      }

      if (isActive()) {
        setCaptureEvidenceIncomplete(Boolean(result.evidenceIncomplete));
        if (result.alreadyCompleted) {
          setCaptureNotice(
            'This PayPal order was already captured. AgentProof reconciled the saved transaction without charging again.',
          );
        } else if (result.reconciled) {
          setCaptureNotice('PayPal reported the order as already captured; AgentProof reconciled the local record.');
        } else if (result.evidenceIncomplete) {
          setCaptureNotice('Payment is complete, but completion evidence is still being reconciled.');
        }

        // Keep the UI truthful even if the follow-up history read fails.
        updateTransaction((prev) =>
          prev && prev.id === result.transactionId
            ? {
                ...prev,
                financialState: 'PAYMENT_COMPLETED',
                paypalCaptureId: result.paypal?.captureId ?? prev.paypalCaptureId,
                updatedAt: new Date().toISOString(),
              }
            : prev,
        );
      }

      if (intentId && isActive()) {
        try {
          // Keep the panel on the transaction that was just captured, even if
          // another transaction for this intent is newer in history.
          await refreshTransactions(intentId, transactionId);
        } catch {
          if (isActive()) {
            setCaptureNotice((prev) =>
              prev ??
              'Payment was confirmed, but saved history could not be refreshed. Reload to view the authoritative record.',
            );
          }
        }
        await refreshEvidence(intentId);
      }
      if (intentId) void loadHistory();

      return result;
    } finally {
      if (isActive()) setActionLoading(false);
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-inner">
          <div>
            <h1 className="app-title">AgentProof</h1>
            <p className="app-tagline">The trust layer for agentic commerce.</p>
          </div>
          <div className="header-account">
            <StatusBanner />
            <span className="header-email" title={user.email}>{user.email}</span>
            <button className="btn btn-secondary btn-small" onClick={onLogout}>
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="app-main">
        <p className="app-intro">
          AI can act for you, but every financial action remains authorized, state-aware, and explainable.
        </p>

        <WorkflowHistory
          intents={intents}
          transactions={transactions}
          selectedIntentId={intent?.id ?? routeIntentId}
          loading={historyLoading || workflowLoading}
          error={historyError}
          onSelect={handleSelectWorkflow}
          onNew={handleNewWorkflow}
          onRefresh={() => { void handleRefresh(); }}
        />

        {workflowLoading && (
          <p className="timeline-loading">Restoring saved workflow…</p>
        )}

        {/* Stage indicator */}
        <nav className="stage-nav" aria-label="Progress">
          {STAGES.map((s, i) => {
            const isActive = s.id === stage;
            const stageIndex = STAGES.findIndex((x) => x.id === stage);
            const isComplete = i < stageIndex;
            const isPending = i > stageIndex;
            return (
              <div key={s.id} className={`stage-item ${isPending ? 'stage-item--pending' : ''}`}>
                <span className={`stage-number ${isActive ? 'stage-number--active' : ''} ${isComplete ? 'stage-number--complete' : ''} ${isPending ? 'stage-number--pending' : ''}`}>
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span className={`stage-label ${isActive ? 'stage-label--active' : ''} ${isPending ? 'stage-label--pending' : ''}`}>{s.label}</span>
              </div>
            );
          })}
        </nav>

        {(flowError || workflowError) && (
          <div className="error-banner" role="alert">{flowError || workflowError}</div>
        )}

        {intent && selectionState.error && (
          <div className="error-banner" role="alert">{selectionState.error}</div>
        )}

        {intent && selection.staleReason && (
          <div className="restored-note" role="note">
            <p>{staleSelectionMessage(selection.staleReason)}</p>
          </div>
        )}

        {/* Intent input */}
        {!intent && !workflowLoading && (
          <section className="panel">
            <h2 className="panel-title">Intent</h2>
            <IntentInput onSubmit={handleIntentSubmit} loading={actionLoading} />
          </section>
        )}

        {/* Structured intent */}
        {intent && (
          <StructuredIntentView rawInput={intent.rawInput} structured={intent.structured} />
        )}

        {/* Discover button */}
        {intent && !discover && !workflowLoading && (
          <div className="action-row">
            <button
              className="btn btn-primary"
              onClick={handleDiscover}
              disabled={
                actionLoading ||
                selectionState.status === 'pending' ||
                selectionState.status === 'unresolved'
              }
            >
              {actionLoading ? 'Discovering…' : 'Find matching products'}
            </button>
          </div>
        )}

        {/* Discovery results */}
        {discover && (
          <section className="panel">
            <div className="panel-title-row">
              <h2 className="panel-title">Discovery & Policy</h2>
              <button
                className="btn btn-secondary btn-small"
                onClick={handleDiscover}
                disabled={
                  actionLoading ||
                  selectionState.status === 'pending' ||
                  selectionState.status === 'unresolved'
                }
              >
                {actionLoading ? 'Evaluating…' : discover.restored ? 'Re-run discovery' : 'Refresh discovery'}
              </button>
            </div>
            <p className="decision-line">
              Decision: <span className={`badge ${discover.decision === 'ALLOW' ? 'badge--allow' : 'badge--deny'}`}>
                {discover.decision}
              </span>
              {discover.confirmationRequired && (
                <span className="badge badge--confirm">Confirmation required</span>
              )}
            </p>
            {discover.restored && (
              <div className="restored-note" role="note">
                <p>
                  Showing saved, policy-approved discovery results, including retained offers from
                  earlier runs. Rejected candidates are not retained as product snapshots. Re-run
                  discovery to evaluate current offers and prices.
                </p>
                {(discover.missingEvaluations ?? 0) > 0 && (
                  <p>
                    {discover.missingEvaluations} saved product association
                    {discover.missingEvaluations === 1 ? '' : 's'} could not be matched to an
                    owner-scoped policy evaluation and {discover.missingEvaluations === 1 ? 'was' : 'were'} hidden.
                  </p>
                )}
              </div>
            )}
            {discover.failureReason === 'COMPOUND_INTENT_NOT_SUPPORTED' && (
              <div className="compound-banner" role="alert">
                <p className="compound-title">Compound purchase not supported</p>
                <p className="compound-message">
                  This request asks for multiple product categories. AgentProof currently supports
                  one product category per request. Please make separate requests for each item.
                </p>
              </div>
            )}
            {discover.allowed.length > 0 && (
              <>
                <p className="selected-label">Authorized options</p>
                <p className="payment-hint">
                  Selecting an offer records your choice for this workflow; it does not place an
                  order.
                </p>
                <div className="candidate-grid">
                  {discover.allowed.map((c) => (
                    <CandidateCard
                      key={`${c.product.source}:${c.product.id}`}
                      candidate={c}
                      state={candidateSelectionState(c, selection)}
                      disabled={selectionState.status === 'pending' || actionLoading}
                      onSelect={() => { void handleSelectProduct(c); }}
                    />
                  ))}
                </div>
              </>
            )}
            {discover.rejected.length > 0 && (
              <>
                <p className="rejected-label">Not authorized</p>
                <div className="candidate-grid">
                  {discover.rejected.map((c) => (
                    <CandidateCard
                      key={`${c.product.source}:${c.product.id}`}
                      candidate={c}
                      state="none"
                    />
                  ))}
                </div>
              </>
            )}
            {!discover.failureReason && discover.candidates.length === 0 && (
              <p className="payment-empty">
                {discover.restored
                  ? 'No saved offers could be reconstructed. Re-run discovery to evaluate current offers.'
                  : 'No products were found for this intent. Re-run discovery or refine the intent.'}
              </p>
            )}
          </section>
        )}

        {/* Explicit retailer handoff (separate from PayPal payment) */}
        {intent && selectedProduct && handoffEnabled && (
          <RetailerHandoff
            enabled={handoffEnabled}
            eligible={handoffEligible}
            snapshot={selectedSnapshot}
            loading={handoffLoading}
            error={handoffError}
            onContinue={handleContinueToRetailer}
          />
        )}

        {/* Payment panel */}
        <PaymentPanel
          product={selectedProduct}
          selectionSnapshot={selectedSnapshot}
          transactionProduct={transactionProduct}
          transaction={transaction}
          evidenceCompleteness={completeness}
          captureNotice={captureNotice}
          confirmationRequired={discover?.confirmationRequired ?? false}
          canStartOrder={canStartOrder}
          orderBlockedReason={orderBlockedReason}
          loading={actionLoading}
          error={paymentError}
          onBuy={handleBuy}
          onCapture={handleCapture}
        />

        {/* Evidence timeline */}
        {intent && (
          <EvidenceTimeline
            events={evidence}
            loading={evidenceLoading}
            error={evidenceError}
          />
        )}
      </main>

      <footer className="app-footer">
        <p>AgentProof — AI interprets intent. Policy decides authorization. User chooses among authorized options. PayPal executes the payment. AgentProof verifies and records what happened.</p>
      </footer>
    </div>
  );
}
