# AgentProof

Audit and control layer for agentic commerce. Ensures every financial action taken by an AI agent is authorized, constrained by deterministic policy, and recorded as auditable evidence.

---

## What is AgentProof?

AgentProof sits between AI intent parsing and financial execution. Its purpose is to:

- **Interpret** free-form user requests into structured purchase intents via an LLM
- **Evaluate** those intents against a deterministic policy engine (price, brand, condition, purpose rules)
- **Present** only ALLOW-listed, immutable product snapshots to the user
- **Execute** PayPal Sandbox orders only after policy ALLOW and explicit user confirmation
- **Record** every step as owner-scoped evidence, with recovery paths for incomplete evidence
- **Isolate** users from each other: no cross-user data access or existence leakage

The deterministic Policy Engine — not the LLM — is the sole authority for financial permission. The LLM may reason and propose; the Policy Engine alone decides ALLOW/DENY.

---

## The Problem it Addresses

AI agents can propose financial actions, but without guardrails those actions are unconstrained. AgentProof provides:

- **Explicit user intent** — every purchase originates from a user-supplied request, parsed into a structured intent
- **Deterministic policy authority** — price, brand, condition, purpose, and confirmation-threshold rules evaluate proposals; the LLM never makes the final call
- **Immutable product snapshots** — selections bind to server-side-captured offers; re-discovery cannot silently redirect to a newer offer
- **PayPal Sandbox verification** — every capture is verified against the original order; mismatched orders are rejected
- **Complete audit trail** — append-only evidence ledger with bounded recovery for incomplete post-capture events
- **User ownership** — all intent, policy, transaction, and evidence records are scoped to the authenticated user; unknown and foreign IDs all return 404 with no existence leak

---

## Core Capabilities (P6)

### Implemented

- ✅ Structured intent model with Zod validation and OpenRouter AI parsing
- ✅ Deterministic Policy Engine (PRICE, BRAND, CONDITION, PURPOSE, CONFIRMATION_THRESHOLD rules)
- ✅ Channel3 or explicit demo product discovery, with per-intent associations that isolate one intent's offers from another's
- ✅ PayPal Sandbox order creation, capture verification, and idempotent retry
- ✅ Append-only, owner-scoped evidence ledger with bounded completion-evidence recovery
- ✅ SQLite by default and MongoDB Atlas explicitly opt-in, with no silent fallback
- ✅ Operator-provisioned accounts, HttpOnly server-side sessions, CSRF/CORS checks
- ✅ Persisted per-user workflow, transaction, discovery, and evidence history
- ✅ Responsive React UI for the full workflow, including loading/empty/error states
- ✅ Unit, repository-contract, API, and frontend tests
- ✅ Policy engine gates PayPal order creation — confirmation required when maxAmount threshold exceeded
- ✅ Selection binding to immutable offer snapshots with freshness windows and mismatch detection
- ✅ Reteller handoff: server-verified URL redirect, never a general-purpose open redirect

### Not implemented

- ❌ Public registration, password reset, account management, or session-management UI
  Accounts are provisioned by the operator at startup; no registration or password-change flow exists.
- ❌ Elasticsearch evidence search
- ❌ AG Grid / Bryntum visualization
- ❌ Dispute flow
- ❌ Additional roles or multi-tenant administration
- ❌ Channel3 integrated checkout — Channel3 provides product discovery and server-verified retailer handoff URLs; purchases are completed outside AgentProof
- ❌ Live PayPal processing — only Sandbox is supported
- ❌ Trend-based discovery, personalized shopping preferences, or daily product update notifications
- ❌ Additional retailer integrations beyond Channel3

---

## Application Workflow

The typical operator-plus-user journey:

1. **Account provisioning** — The operator sets `AUTH_INITIAL_EMAIL` and `AUTH_INITIAL_PASSWORD` in `.env`; `initDb()` creates the account once at startup. There is no public registration route.

2. **Sign in** — The operator-signed-in user visits `http://localhost:5173`, the app reads the `agentproof_session` HttpOnly cookie, and grants access.

3. **Create intent** — The user submits a free-form request (e.g., "Buy me running shoes under $150, new only"). The app sends it to `POST /api/v1/intent`, which:
   - Forwards the raw text to OpenRouter LLM for parsing into a structured intent
   - Persists the intent owned by the authenticated user with status VALIDATED
   - Returns the intent ID, routing the user to the discovery stage

4. **Product discovery** — The user clicks **Find matching products**, which calls `POST /api/v1/products/discover`. The server:
   - Retrieves the user's persisted structured intent
   - Runs the DiscoveryFlowService: policy engine evaluates each candidate product
   - Only ALLOW-listed products are stored as server-side snapshots (never client-supplied data)
   - Persists per-intent discovery associations so one intent's offers never overwrite another's
   - Returns the decision (ALLOW/DENY), allowed/ rejected candidates, and freshness info

5. **Select product** — The user clicks **Select** on an ALLOW candidate. The server:
   - Binds the selection to the exact immutable offer snapshot (price, currency, merchant snapshotted at discovery time)
   - Enforces freshness window — stale snapshots are rejected
   - Records PRODUCT_SELECTED evidence, bound to the selection row
   - Returns the confirmed selection; the user can now proceed to payment

6. **PayPal order creation** — The user clicks **Buy with PayPal**. The server:
   - Re-evaluates policy against the persisted selection snapshot
   - If confirmation is required (price above threshold), returns CONFIRMATION_REQUIRED
   - If policy DENIED, returns 422 with evaluation details
   - If authorized, creates a PayPal Sandbox order
   - Persists a PAYMENT_PENDING transaction row (never PAYMENT_COMPLETED until capture)
   - Returns the order ID, approval URL, and policy evaluation

7. **PayPal approval** — The browser loads the PayPal SDK and the user approves the order in PayPal Sandbox.

8. **PayPal capture** — The user (or flow) completes capture. The server:
   - Verifies the captured order matches the transaction (amount, currency, invoice ID)
   - If verified, transitions the transaction to PAYMENT_COMPLETED
   - Records PAYPAL_PAYMENT_CAPTURED and PAYMENT_CAPTURED evidence events
   - If evidence persistence fails, reports PAYMENT_COMPLETED with evidenceIncomplete flag and RECOVERY_PENDING status
   - Returns the capture result with financialState

9. **Evidence and history** — The user views the evidence timeline and saved workflow. The persisted transaction (not the transient PayPal response) is the source of truth for display. Completion evidence status is shown explicitly, with a reconcile action if evidence is incomplete.

10. **Browser refresh** — The user's hash route (`#/?intent=<id>`) rehydrates the full workflow from the server: intent, discoveries, policy evaluations, latest transaction, and evidence. No re-discovery or stale client state is trusted.

---

## Architecture and Technology Stack

### Persistence Providers

The application supports exactly two persistence providers, selected via `PERSISTENCE_PROVIDER` env variable (default: `sqlite`):

| Feature | SQLite (default) | MongoDB Atlas |
|---|---|---|
| **Database** | sql.js in-process, DB file at `DB_PATH` | MongoDB Atlas cluster |
| **Configuration** | `DB_PATH` (default: `./data/agentproof.db`) | `MONGODB_URI`, `MONGODB_DB` |
| **Startup** | Load or create DB, run migrations, provision initial account | Connect, create P2-B through P6 indexes, abort on failure |
| **Fallback** | None — explicit provider choice required | None — explicit provider choice required |
| **Credits** | None required | `MONGODB_URI` must not be embedded in frontend bundles |

### Key Design Principles

- **No automatic fallback** — selecting `mongodb` and having missing/invalid config fails startup clearly
- **MongoDB DNS fix required** — Windows default DNS (127.0.0.1) cannot resolve Atlas SRV records; set `dns.setServers(['8.8.8.8'])` at startup
- **No hybrid store** — product/discovery data lives entirely in one provider or the other; no SQLite+MongoDB mix
- **Credentials stay server-side** — `MONGODB_URI`, `OPENROUTER_API_KEY`, `CHANNEL3_API_KEY`, and `PAYPAL_CLIENT_SECRET` never reach the browser

### Authentication and Sessions

- **Operator-provisioned accounts only** — `AUTH_INITIAL_EMAIL` and `AUTH_INITIAL_PASSWORD` in `.env`; no registration, reset, or password-change flow
- **HttpOnly session cookie** — `agentproof_session`, `SameSite=Strict`, `Path=/`, `Secure` controlled by `AUTH_COOKIE_SECURE`
- **Session validation on each protected route** — token hash looked up in repository; active lookup enforces `expiresAt` and `revokedAt`
- **No browser storage for tokens** — cookies only; `credentials: 'include'` on all API requests
- **401 → sign-in screen** — expired or revoked session returns the user to the login page

### Ownership and Access Isolation

- **Every repository query is scoped to the authenticated user** — `userId` from the session, never from client input
- **Unknown IDs and other users' IDs both return 404** — no existence leak
- **List/filter/get cannot widen access** — filtering by `intentId` or `transactionId` on evidence returns only the caller's records
- **Client-supplied `userId` fields are ignored** — intent context resolves from the persisted, owned intent

### Evidence Integrity and Recovery

- **Deterministic evidence IDs** (`ev:<transactionId>:<eventType>`) with atomic insert-if-absent writes
- **Retries and concurrent writers converge on one record** — no duplicates or overwrites
- **Post-capture evidence recovery** is bounded: only writes missing events for a persisted `PAYMENT_COMPLETED` transaction with a PayPal order ID
- **Recovery is best-effort** — a completed transaction with missing evidence is reconciled on the next capture retry or explicit check-evidence action
- **Evidence never supersedes the durable transaction state** — even if evidence reconciliation fails, the financial state remains as persistently recorded

### Payment Idempotency

- **Order creation** produces a transaction in PAYMENT_PENDING state with a PayPal order ID
- **Capture** is idempotent: retrying an already-completed transaction returns `ALREADY_COMPLETED` without re-capturing
- **Order attempts** table enforces unique `(user_id, idempotency_key)` — a retry is a lookup, not a second PayPal order
- **Payment completion** is durable: once the transaction is `PAYMENT_COMPLETED`, it survives API restarts and browser refreshes

### External Service Integrations

| Service | Role | Credentials |
|---|---|---|
| **OpenRouter** | LLM intent parsing | `OPENROUTER_API_KEY` (server-side only) |
| **PayPal Sandbox** | Order creation and capture | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` (client ID forwarded to browser; secret stays server-side) |
| **Channel3** | Product discovery API | `CHANNEL3_API_KEY` (server-side only) |
| **OpenDB** | MongoDB Atlas | `MONGODB_URI`, `MONGODB_DB` (server-side only) |

### Error Handling and Important Limitations

- **Missing credentials** are configuration blockers, not silent failures. A real payment/capture requires operator-supplied Sandbox credentials.
- **Channel3 checkout is not integrated** — the handoff endpoint returns a server-verified URL; opening the retailer does not complete a purchase inside AgentProof, and the app records no purchase claim.
- **MongoDB Atlas requires public DNS** — Windows 127.0.0.1 cannot resolve SRV records; `dns.setServers(['8.8.8.8'])` is a process-level fix at startup.
- **No background reconciliation worker** — completed-transaction evidence is reconciled on the next capture retry or explicit action.
- **SQLite single-process only** — concurrent API processes against the same `DB_PATH` race on whole-file replacement.
- **Prices and availability are snapshotted** at discovery time — re-discovery is required for current data.
- **Compound intents (multiple product categories)** are not supported — each request must request one product category.

---

## Project Structure

```
agentproof/
├ apps/
│   ├── api/              # Express backend (port 3001)
│   └── web/              # React frontend (port 5173)
├ packages/
│   └── shared/           # Shared Zod schemas and types
├ data/                   # SQLite database file (generated at startup)
└ README.md
```

### API (`apps/api/`)

- Entry: `src/index.ts` — initializes persistence, then mounts routers under `/api/v1/`
- Routers: `auth.ts`, `intent.ts`, `policy.ts`, `evidence.ts`, `products.ts`, `selections.ts`, `payments.ts`
- Models: `db.ts` (SQLite schema + migration), `repositories.ts` (provider resolution), `persistenceProvider.ts` (provider selection), `startup.ts` (DNS + init + index)
- Middleware: `auth.ts` (requireAuth, optionalAuth)
- Services: AI (intent parsing), Policy Engine, Discovery Flow, Product Resolution, PayPal Client, Evidence Service, Order Creation

### Web (`apps/web/`)

- Entry: `src/App.tsx` — hash-route driven workflow (intent → policy → product → payment → evidence)
- Components: `LoginScreen`, `IntentInput`, `CandidateCard`, `PaymentPanel`, `EvidenceTimeline`, `WorkflowHistory`, `StructuredIntentView`, `RetailerHandoff`
- Hooks: `useHashRoute`, `useSearchParams`
- API client: `src/api.ts` (imported types and functions from shared)

### Shared (`packages/shared/`)

- Zod schemas: `structuredIntentSchema`, `productSchema`, `policyEvaluationSchema`, `evidenceRecordSchema`, etc.
- Type definitions: `StructuredIntent`, `Product`, `PolicyEvaluation`, `EvidenceRecord`, `FinancialState`, etc.

---

## Getting Started

### Prerequisites

- Node.js >= 22.0.0
- Git
- PayPal Sandbox account (for end-to-end payment flow)
- OpenRouter API key (for AI intent parsing, optional if using pre-structured intents)
- Channel3 API key (for live discovery, optional if using demo catalog)

### Installation

```bash
npm install
```

### Environment Configuration

1. **Create `.env` at the repository root** (no example file included; copy the config below):

   ```dotenv
   # Required for the authenticated UI flow (both must be set together)
   AUTH_INITIAL_EMAIL=you@example.com
   AUTH_INITIAL_PASSWORD=<at-least-12-characters>
   WEB_ORIGIN=http://localhost:5173

   # Discovery source (choose one)
   DISCOVERY_PROVIDER=demo
   # or for live Channel3:
   DISCOVERY_PROVIDER=channel3
   CHANNEL3_API_KEY=<server-side-channel3-key>

   # Natural-language intent parsing
   OPENROUTER_API_KEY=<server-openrouter-key>
   OPENROUTER_MODEL=openai/gpt-4o-mini

   # PayPal Sandbox
   PAYPAL_CLIENT_ID=<sandbox-client-id>
   PAYPAL_CLIENT_SECRET=<sandbox-client-secret>
   PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com
   PAYPAL_RETURN_URL=http://localhost:5173/#/payment/return
   PAYPAL_CANCEL_URL=http://localhost:5173/#/payment/cancel

   # Persistence provider (sqlite by default)
   PERSISTENCE_PROVIDER=sqlite

   # MongoDB Atlas (explicit opt-in; requires all three)
   # PERSISTENCE_PROVIDER=mongodb
   # MONGODB_URI=mongodb+srv://<user>:<password>@<cluster-host>/?retryWrites=true&w=majority
   # MONGODB_DB=agentproof

   # Channel3 handoff configuration
   RETAILER_HANDOFF_ENABLED=false
   CHANNEL3_ALLOWED_LINK_HOSTS=buy.trychannel3.com
   ```

2. **Important**: `PAYPAL_CLIENT_ID` is forwarded to the browser for the PayPal SDK. All other credentials remain server-side only.

3. **Start the services** (separate terminals):

   ```bash
   npm run dev:api
   npm run dev:web
   ```

4. **Open the app** at `http://localhost:5173`, sign in with the provisioned account, and complete the workflow.

### SQLite Database Location

The default `DB_PATH=./data/agentproof.db` resolves relative to the API working directory (`apps/api`), producing `apps/api/data/agentproof.db`. The path is created automatically on first startup; an existing file is loaded and migrated; empty or corrupt files fail startup.

### MongoDB Atlas Setup

To select MongoDB explicitly:

```dotenv
PERSISTENCE_PROVIDER=mongodb
MONGODB_URI=mongodb+srv://<username>:<password>@<cluster-host>/?retryWrites=true&w=majority
MONGODB_DB=agentproof
```

A startup DNS fix is required on Windows: the process-level `dns.setServers(['8.8.8.8'])` enables Atlas SRV resolution. See the **Deployment considerations** section below.

---

## Testing and Build Commands

| Command | Scope |
|---|---|
| `npm run build` | Build all packages and apps (shared → api → web) |
| `npm run typecheck` | Type-check all packages and apps |
| `npm run test:api` | API test suite (Vitest) |
| `npm run test:web` | Frontend test suite (Vitest + React Testing Library) |
| `npm test` | Run both API and web test suites |

### API Tests

- 675+ tests across: repository contracts, service logic, route handlers, cross-user regression
- Cross-user tests use in-memory repo pattern to avoid SQLite initDb() blocker
- 1 pre-existing failure: `persistenceProvider.test.ts` expects `sqlite` but env has `mongodb` configured

### Web Tests

- 72 tests across: selection, workflow, API auth, API history, router, api selection, api auth, api handoff

### TypeScript Build Fix

Added `"exclude": ["**/*.test.ts", "**/*.spec.ts"]` to `apps/api/tsconfig.json` so that `tsc --noEmit` does not compile test files, eliminating 3 diagnostic errors in `cross-user-regression.test.ts`.

---

## Deployment Considerations

### Render / Production Deployment

- **Set `NODE_ENV=production`** — this prunes devDependencies and affects cookie security settings
- **Persistence provider** — default is `sqlite`; to use MongoDB, set `PERSISTENCE_PROVIDER=mongodb` with valid `MONGODB_URI` and `MONGODB_DB`
- **DNS fix for MongoDB** — on Windows, the process-level `dns.setServers(['8.8.8.8'])` in `startup.ts` enables Atlas SRV resolution. On Linux/macOS, the system DNS resolver typically handles SRV records correctly.
- **Environment variables** — all secrets (`MONGODB_URI`, `OPENROUTER_API_KEY`, `PAYPAL_CLIENT_SECRET`, `CHANNEL3_API_KEY`) must be set as Render environment variables, never in the codebase
- **CORS** — set `WEB_ORIGIN` to the production frontend URL; `CORS_ORIGIN` can be set to `null` to disable CORS in production
- **Cookie security** — `AUTH_COOKIE_SECURE` defaults to `on` in production; ensure the deployment uses HTTPS
- **No automatic startup provisioning** — the operator must ensure `AUTH_INITIAL_EMAIL` and `AUTH_INITIAL_PASSWORD` are set if an initial account is needed at startup

### MongoDB SRV Resolution

The MongoDB Atlas connection string uses SRV records for load balancing and failover. On Windows, the default DNS resolver (127.0.0.1) cannot resolve these records. The fix is a process-level configuration in `apps/api/src/models/startup.ts`:

```typescript
dns.setServers(['8.8.8.8']);
```

This is set once at startup, before any MongoDB connection attempt. On Linux and macOS, the system DNS resolver typically handles SRV records without additional configuration.

### Live PayPal Blocked

This repository does not contain PayPal Sandbox credentials, and no external service was contacted during implementation. A real payment/capture can only be verified after the operator provisions a Sandbox app and account with the required environment variables. Missing credentials must be reported as a configuration blocker, not bypassed with fake success states.

### Channel3 Handoff

The retailer handoff endpoint returns a server-verified URL bound to the exact offer snapshot the user selected. Opening this URL completes the purchase outside AgentProof; the app records no purchase claim and does not intercept the redirect. The handoff feature is disabled by default (`RETAILER_HANDOFF_ENABLED=false`) and must be explicitly enabled by the operator with approved allowed link hosts.

---

## Security and Trust Model

### What AgentProof Guarantees

- **No financial action occurs without explicit user intent** — every purchase starts from a user-supplied request
- **The Policy Engine (not the LLM) controls ALLOW/DENY** — all financial permission is deterministic and auditable
- **PayPal capture is verified** — amount, currency, and invoice ID must match the original order before any state transition
- **User data is isolated** — every repository query is scoped to the authenticated user; no cross-user access or existence leakage
- **Evidence is append-only and deterministic** — deterministic IDs and insert-if-absent writes prevent duplicates; recovery is bounded
- **Selections bind to immutable snapshots** — re-discovery cannot silently redirect to a newer or different offer
- **Credentials never reach the browser** — `MONGODB_URI`, `OPENROUTER_API_KEY`, `PAYPAL_CLIENT_SECRET`, `CHANNEL3_API_KEY` are server-side only

### Trusted Paths

- Operator provisions the initial account at startup (`AUTH_INITIAL_EMAIL` + `AUTH_INITIAL_PASSWORD`)
- All API requests include `credentials: 'include'` to send the HttpOnly session cookie
- Frontend probes `/api/v1/auth/session` on load; unauthenticated users are shown the sign-in screen
- State-changing requests must match `WEB_ORIGIN` via CORS or SameSite/Referer checks
- PayPal order creation and capture are gated by policy evaluation; confirmation is required when the price exceeds the threshold

### Threat Model Summary

| Threat | Mitigation |
|---|---|
| AI proposes unauthorized action | Policy Engine alone decides ALLOW/DENY; LLM output is never the final authority |
| User accesses another user's data | Ownership scoped to session userId; foreign IDs return 404 |
| Client tampers with price/currency | All price/currency resolved from server-side discovery snapshots, never from request body |
| PayPal order forged | Capture verification checks amount, currency, and invoice ID match |
| Evidence overwritten or duplicated | Deterministic IDs + atomic insert-if-absent; retries converge on one record |
| Stale offer selected after re-discovery | Selections bind to exact snapshotId; freshness window enforced; mismatch detected |
| MongoDB credentials leaked | All credentials server-side only; never in frontend bundles or environment files exposed to clients |

---

## Current Limitations

- **No public registration, password reset, or account management UI** — accounts are operator-provisioned only
- **SQLite is a single-process store** — do not run multiple API processes against the same `DB_PATH`
- **PayPal completion requires operator-supplied Sandbox credentials** — no end-to-end verification without them
- **Channel3 provides product discovery and server-verified handoff URLs only** — integrated checkout is not implemented
- **MongoDB Atlas requires explicit configuration and DNS fix** (Windows: `dns.setServers(['8.8.8.8'])` at startup)
- **No background reconciliation worker** — completed-transaction evidence is reconciled on the next capture retry or explicit action
- **Prices and availability are snapshotted at discovery time** — re-discovery required for current data
- **Compound intents (multiple product categories)** are not supported
- **No session cleanup job for SQLite** — expired rows are ignored by active lookup but not physically deleted
- **Legacy ownerless data** (pre-P5) is intentionally hidden from normal users; trusted operator path required for migration
- **No WAL or multi-writer coordination** for SQLite — one API process per `DB_PATH`

### Roadmap (planned, not implemented)

- **Personalised shopping preferences** — user-configurable preferences for product categories, price ranges, and brands
- **Daily personalised product updates** — curated product recommendations based on saved preferences and discovery history
- **Price and availability change notifications** — alerts when monitored products change price or become available
- **Trend-based discovery** — when reliable popularity data is available, feature products with rising interest
- **Channel3 checkout capability** — investigation of deeper Channel3 integration for completing purchases within the workflow; not currently implemented
- **Additional retailer integrations** — supporting outbound links to additional merchant platforms beyond Channel3
- **Future PayPal-connected purchasing workflows** — beyond the current Sandbox verification, exploring end-to-end PayPal-connected purchase flows that remain explicitly authorized by the user

All future roadmap items are aspirational and will be implemented only after explicit approval. None of the above should be described as completed or guaranteed functionality. Consequential financial actions must always require explicit user authorization.

---

## License

MIT License

Copyright (c) 2026 Isaiah Yemi Adelowo

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.