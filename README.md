# AgentProof

Audit and control layer for agentic commerce. Ensures every financial action taken by an AI agent is authorized, constrained by deterministic policy, and recorded as auditable evidence.

---

## What is AgentProof?

AgentProof sits between AI intent parsing and financial execution. Its purpose is to interpret user requests, evaluate them against deterministic policy, present only authorized product snapshots, execute PayPal Sandbox orders only after explicit user confirmation, and record every step as owner-scoped evidence.

The deterministic Policy Engine — not the LLM — is the sole authority for financial permission. The LLM may reason and propose; the Policy Engine alone decides ALLOW/DENY.

---

## Core Features (Implemented)

The following features are implemented and verified by the test suite:

- **Structured intent model** with Zod validation and OpenRouter AI parsing
- **Deterministic Policy Engine** (PRICE, BRAND, CONDITION, PURPOSE, CONFIRMATION_THRESHOLD rules) — sole authority for ALLOW/DENY decisions
- **Channel3 or explicit demo product discovery**, with per-intent associations that isolate one intent's offers from another's
- **PayPal Sandbox order creation, capture verification, and idempotent retry**
- **Append-only, owner-scoped evidence ledger** with bounded completion-evidence recovery
- **SQLite by default and MongoDB Atlas explicitly opt-in**, with no silent fallback
- **Operator-provisioned accounts**, HttpOnly server-side sessions, CSRF/CORS checks
- **Persisted per-user workflow, transaction, discovery, and evidence history**
- **Responsive React UI** for the full workflow, including loading/empty/error states
- **Unit, repository-contract, API, and frontend tests**
- **Policy engine gates PayPal order creation** — confirmation required when maxAmount threshold exceeded
- **Selection binding to immutable offer snapshots** with freshness windows and mismatch detection
- **Retailer handoff**: server-verified URL redirect, never a general-purpose open redirect

---

## Problem and Design Approach

AI agents can propose financial actions without guardrails, leading to unconstrained behavior. AgentProof provides explicit guardrails:

- **Explicit user intent** — every purchase originates from a user-supplied request, parsed into a structured intent
- **Deterministic policy authority** — price, brand, condition, purpose, and confirmation-threshold rules evaluate proposals; the LLM never makes the final call
- **Immutable product snapshots** — selections bind to server-side-captured offers; re-discovery cannot silently redirect to a newer offer
- **PayPal Sandbox verification** — every capture is verified against the original order; mismatched orders are rejected
- **Complete audit trail** — append-only evidence ledger with bounded recovery for incomplete post-capture events
- **User ownership** — all intent, policy, transaction, and evidence records are scoped to the authenticated user; unknown and foreign IDs all return 404 with no existence leak

---

## Authentication and User Management

* **User registration and sign-in**: AgentProof provides a registration flow for creating user accounts and a login flow for existing users.
* **Initial account provisioning**: `AUTH_INITIAL_EMAIL` and `AUTH_INITIAL_PASSWORD` configure the initial account through `provisionInitialAuth()`. This is initial account provisioning, not the application's only account-creation mechanism.
* **HttpOnly session cookie**: Authentication uses the `agentproof_session` cookie, configured with `SameSite`, `Path=/`, and `Secure` controlled by `AUTH_COOKIE_SECURE`.
* **Cross-site cookie configuration**: `SameSite` defaults to `strict`. Production deployments requiring cross-site cookies can set `AUTH_COOKIE_SAMESITE=none`, accompanied by `AUTH_COOKIE_SECURE=true`.
* **Consistent registration and login sessions**: Both registration and login establish sessions using matching cookie attributes.
* **Session validation**: Protected routes validate sessions against the stored token hash. Active session lookup enforces `expiresAt` and `revokedAt`.
* **No browser token storage**: Session tokens are maintained through HttpOnly cookies rather than browser-accessible storage. API requests include `credentials: 'include'`.
* **Session expiry and revocation**: Invalid, expired, or revoked sessions result in an unauthenticated response, returning the user to the sign-in screen.

### User Data Isolation

Every repository query is scoped to the authenticated user's `userId` obtained from the session, never from client input.

Unknown resource IDs and resources belonging to other users both return `404`, preventing resource-existence disclosure. Client-supplied `userId` fields are ignored, and intent context is resolved from the persisted intent owned by the authenticated user.

---

## AI and Deterministic Policy Architecture

### Policy Engine

The Policy Engine is a deterministic rules engine that evaluates product candidates against:

- **PRICE rule** — compares product price against `maxAmount` threshold
- **BRAND rule** — compares product brand against allowed list
- **CONDITION rule** — compares product condition (`new`, `used`, `unknown`)
- **PURPOSE rule** — matches product name against purpose keywords
- **CONFIRMATION_THRESHOLD** — when exceeded, requires explicit user confirmation before PayPal order creation

The Policy Engine — not the LLM — is the sole authority for ALLOW/DENY decisions. The LLM may reason and propose structured intents; the Policy Engine alone controls financial permission.

### AI: OpenRouter Intent Parsing

- `OPENROUTER_API_KEY` (server-side only, never bundled to browser)
- Default model: `openai/gpt-4o-mini`
- Parses free-form user requests into structured intents (purpose, isCompound, maxAmount, currency, brands, condition, constraints)
- If parsing fails or returns invalid structured intent, the API returns 400 with error details
- Structured intents are persisted alongside the intent record

### Policy + Discovery Interaction

- Policy evaluation occurs during product discovery (`POST /api/v1/products/discover`)
- Only ALLOW-listed products are stored as server-side offer snapshots
- The request body's `structuredIntent` is never used for the policy decision — the persisted intent's structured data is authoritative
- Policy evaluation also gates PayPal order creation (`POST /api/v1/payments/create-order`)

### Policy + Payment Interaction

- Policy re-evaluation occurs before PayPal order creation
- If CONFIRMATION_REQUIRED, the API returns 409 with `confirmationRequired: true`
- The user must re-confirm; the flow then proceeds to order creation
- If DENIED, the API returns 422 with evaluation details

---

## Product Discovery and Selection

### Discovery Providers

- **`DISCOVERY_PROVIDER=demo`** — uses an in-memory demo catalog (no API key required)
- **`DISCOVERY_PROVIDER=channel3`** — uses Channel3 product discovery API (`CHANNEL3_API_KEY` required, server-side only)

### Discovery Flow

1. User submits intent ID → `POST /api/v1/products/discover`
2. Server retrieves the user's persisted structured intent
3. DiscoveryFlowService runs: policy engine evaluates each candidate product against the structured intent rules
4. Only ALLOW-listed products are stored as server-side snapshots in the `offers` collection (MongoDB) or persisted in SQLite
5. Per-intent discovery associations (`intentDiscoveries` collection) isolate one intent's offers from another's
6. Each discovered product gets an immutable snapshot (`offerSnapshots` / `P5` tables) capturing: productId, price, currency, brand, condition, category, name, merchant, imageUrl, productUrl, availability, externalId
7. Freshness window (configurable via `DEFAULT_PRODUCT_MAX_AGE_MS`) — stale snapshots are rejected
8. Result returned: decision (ALLOW/DENY), allowed/rejected candidates, freshness info, handoff eligibility

### Selection

1. User clicks **Select** on an ALLOW candidate → `POST /api/v1/selections`
2. Server binds the selection to the exact immutable offer snapshot (snapshotId is identity, never price/currency input)
3. Freshness window enforced — stale snapshots rejected (410 STALE_SNAPSHOT)
4. Defensive identity checks: resolved snapshot must exactly match the client's requested intent, source, and product
5. PRODUCT_SELECTED evidence recorded, bound to the selection row
6. Response includes `selection` (SelectionView projection) and `evidenceRecorded`/`evidenceError` (partial success: selection persisted but evidence failed is reported without rolling back the selection)
7. The user can now proceed to payment

### Order Creation

1. User clicks **Buy with PayPal** → `POST /api/v1/payments/create-order`
2. Server re-evaluates policy against the persisted selection snapshot
3. If CONFIRMATION_REQUIRED → returns 409 with `confirmationRequired: true`
4. If DENIED → returns 422 with evaluation details
5. If authorized → OrderCreationService creates PayPal Sandbox order
6. Persists a `PAYMENT_PENDING` transaction row (never `PAYMENT_COMPLETED` until capture)
7. Returns: `transactionId`, `financialState: PAYMENT_PENDING`, `paypal: { orderId, status, approveUrl }`, `evaluation`, `confirmationRequired`

---

## Retailer Handoff

The retailer handoff endpoint returns a server-verified URL bound to the exact offer snapshot the user selected.

- **Endpoint**: `POST /api/v1/products/handoff`
- **Feature flag**: `RETAILER_HANDOFF_ENABLED` (default: `false`; must be explicitly enabled via Render dashboard or `.env`)
- **Allowed hosts**: `CHANNEL3_ALLOWED_LINK_HOSTS` (e.g., `buy.trychannel3.com`)
- **Validation**: The server re-validates the URL safety against allowed tracking hosts before returning it

**What it does:**

- Returns a `url`, `disclosure`, and `offer` (OfferSnapshotView) — the outbound URL comes only from the server-side snapshot, is re-validated here, and is returned as JSON rather than a redirect so this endpoint can never become a general-purpose open redirect.
- The URL is bound to the exact offer snapshot the user selected — re-discovery may replace the association with a newer snapshot, and this write must never silently bind the newer offer.

**What it does not do:**

- Opening this URL completes the purchase outside AgentProof; the app records no purchase claim and does not intercept the redirect.
- Integrated checkout is not implemented — Channel3 provides product discovery and server-verified handoff URLs only; purchases are completed outside AgentProof.

The browser explicitly navigates to the returned URL (`window.location.assign(result.url)`). After navigation, AgentProof has no control over the external retailer experience.

---

## PayPal Integration

### PayPal Sandbox Only

This implementation supports PayPal Sandbox only. Live PayPal processing is not supported.

### Order Creation

1. `POST /api/v1/payments/create-order` → `OrderCreationService`
2. Authoritative intent context from repository (scoped to this user, client cannot override)
3. Authoritative product offer from trusted server-side snapshot (or demo catalog) — never from client and never a silent fallback
4. ORDER_CREATED → transaction starts `PAYMENT_PENDING`. Never `PAYMENT_COMPLETED`.
5. Transaction persisted with: `paypalOrderId`, `paypalCaptureId: null`, `financialState: PAYMENT_PENDING`, `amount`, `currency`
6. Returns: `transactionId`, `financialState: PAYMENT_PENDING`, `paypal: { orderId, status, approveUrl }`, `evaluation`, `confirmationRequired`

### PayPal Approval

- Browser loads PayPal SDK with `VITE_PAYPAL_CLIENT_ID` (forwarded from `PAYPAL_CLIENT_ID` server-side)
- User approves the order in PayPal Sandbox
- Browser returns to the app via the configured return/cancel URLs

### PayPal Capture

1. `POST /api/v1/payments/capture` → `PaymentService.captureApprovedOrder`
2. Server verifies the captured order matches the transaction:
   - Amount must match
   - Currency must match
   - Invoice ID must match the original order ID
3. If verified → transitions transaction to `PAYMENT_COMPLETED`
4. Records evidence events: `PAYPAL_PAYMENT_CAPTURED`, `PAYMENT_CAPTURED`
5. If evidence persistence fails → returns `PAYMENT_COMPLETED` with `evidenceIncomplete: true` and `evidenceStatus: 'RECOVERY_PENDING'`
6. Returns: `transactionId`, `financialState`, `reconciled`, `evidenceIncomplete`/`evidenceStatus`, paypal details (orderId, captureId, amount, currency, orderStatus, captureStatus)

**Critical distinction**: Order creation ≠ payment completed. Capture verification is required before the financial state transitions to COMPLETED.

### Idempotency

- Deterministic evidence IDs: `ev:<transactionId>:<eventType>` with atomic insert-if-absent writes
- Unique constraint on `(user_id, idempotency_key)` in the order attempts table — a retry is a lookup, not a second PayPal order
- Capture is idempotent: retrying an already-completed transaction returns `ALREADY_COMPLETED` without re-capturing

### Error Handling and Recovery

- **CAPTURE_UNVERIFIED** (502) — PayPal capture could not be verified; details provided
- **INVALID_STATE** (409) — Transaction is not payable
- **ALREADY_COMPLETED** — Retry of an already-completed transaction returns this status; evidence recovery may still be needed
- **Recovery**: `recoverEvidenceForCompletedTransaction` best-effort recovery for missing completion evidence after post-capture failure. Reads the persisted transaction, never calls PayPal, writes only missing deterministic completion events.

---

## Saved Workflows and Payment History

### Persisted Workflow

- User's hash route (`#/?intent=<id>`) rehydrates the full workflow from the server
- Includes: intent, discoveries (policy evaluations), latest transaction, evidence records
- No re-discovery or stale client state is trusted
- Workflow restoration uses monotonic request IDs and epoch/load refs to prevent older in-flight restores from overwriting newer state

### Payment History

- `GET /api/v1/payments/history` — lists transactions for the authenticated user, with optional `intentId` filter and `limit` (max 50)
- Each transaction includes: `transactionId`, `intentId`, `financialState`, `amount`, `currency`
- `GET /api/v1/payments/by-order/:orderId` — finds transaction by PayPal order ID (scoped to authenticated user)

### Evidence Timeline

- `GET /api/v1/evidence` — lists all evidence records for the authenticated user
- `GET /api/v1/evidence?intentId=<id>` — filters by intent
- `GET /api/v1/evidence?transactionId=<id>` — filters by transaction
- Single record: `GET /api/v1/evidence/:id`
- Evidence record types: PRODUCT_SELECTED, POLICY_EVALUATED, PAYPAL_PAYMENT_CAPTURED, PAYMENT_CAPTURED, EVIDENCE_RECOVERED

### Reconciliation

- No background reconciliation worker — completed-transaction evidence is reconciled on the next capture retry or explicit user action
- Explicit check: user can trigger evidence reconciliation to ensure all events are persisted
- Evidence never supersedes the durable transaction state — even if evidence reconciliation fails, the financial state remains as persistently recorded

---

## Architecture and Technology Stack

### Frontend

- **React 18** with Vite 5
- Hash-routed workflow (intent → policy → product → payment → evidence)
- Components: `LoginScreen`, `IntentInput`, `CandidateCard`, `PaymentPanel`, `EvidenceTimeline`, `WorkflowHistory`, `StructuredIntentView`, `RetailerHandoff`
- Hooks: `useHashRoute`, `useSearchParams`
- API client: `src/api.ts` — fetch-based with `VITE_API_URL` base and `credentials: 'include'`
- Vite env injection: `process.env` takes precedence over `.env` for `VITE_PAYPAL_CLIENT_ID` and `VITE_API_URL`
- PayPal SDK: initialized with `import.meta.env.VITE_PAYPAL_CLIENT_ID`
- Responsive design with loading/empty/error states

### Backend

- **Node.js 22** with Express 5
- TypeScript throughout
- Workspaces: `apps/api`, `apps/web`, `packages/shared`
- CORS: configured with `config.webOrigin`, `credentials: true`
- CSRF: origin-checked; non-browser clients (no origin header) are allowed; SameSite cookie context handled correctly
- Rate limiting: not configured (operational concern for production deployment)

### Shared Package

- **Zod schemas** for: structured intent, product, policy evaluation, evidence record, financial state, action types, authority status, action authorization
- **Type definitions** for: StructuredIntent, Product, PolicyEvaluation, EvidenceRecord, FinancialState, ActionType, AuthorityStatus, ActionAuthorization, Intent, Transaction, ApprovalRequest
- Re-exports all schemas and types via `index.ts`
- No runtime dependencies beyond `zod`

### Persistence

- **SQLite (default)** — sql.js in-process, DB file at `DB_PATH` (default: `./data/agentproof.db`)
- **MongoDB Atlas** — explicit opt-in via `PERSISTENCE_PROVIDER=mongodb` with `MONGODB_URI` and `MONGODB_DB`
- **No hybrid store** — product/discovery data lives entirely in one provider or the other
- **No automatic fallback** — selecting `mongodb` with missing/invalid config fails startup clearly
- **MongoDB DNS fix** — Windows: process-level `dns.setServers(['8.8.8.8'])` at startup enables Atlas SRV resolution. Linux/macOS typically handles SRV natively.
- **Credentials stay server-side** — `MONGODB_URI`, `OPENROUTER_API_KEY`, `PAYPAL_CLIENT_SECRET`, `CHANNEL3_API_KEY` never reach the browser

### API Organization

- Entry: `src/index.ts` — initializes persistence, then mounts routers under `/api/v1/`
- Routers: `auth.ts`, `intent.ts`, `policy.ts`, `evidence.ts`, `products.ts`, `selections.ts`, `payments.ts`
- Middleware: `auth.ts` (requireAuth, optionalAuth), `csrf.ts` (CSRF protection)
- All protected routes use `requireAuth` middleware
- Session cookie attached via `credentials: 'include'` on all API requests from the frontend

### External Service Integrations

| Service | Role | Credentials |
|---|---|---|
| **OpenRouter** | LLM intent parsing | `OPENROUTER_API_KEY` (server-side only) |
| **PayPal Sandbox** | Order creation and capture | `PAYPAL_CLIENT_ID` (forwarded to browser), `PAYPAL_CLIENT_SECRET` (server-side only) |
| **Channel3** | Product discovery API | `CHANNEL3_API_KEY` (server-side only) |
| **MongoDB Atlas** | Persistence provider | `MONGODB_URI`, `MONGODB_DB` (server-side only) |

---

## Repository Structure

```
agentproof/
├ apps/
│   ├── api/                  # Express backend (port 3001)
│   │   ├── src/
│   │   │   ├── index.ts          # Server entry point
│   │   │   ├── config/env.ts     # Configuration
│   │   │   ├── routes/           # API routers (auth, intent, policy, evidence, products, selections, payments)
│   │   │   ├── models/           # DB, repositories, persistence provider
│   │   │   ├── services/         # Business logic services
│   │   │   ├── middleware/       # Auth, CSRF
│   │   │   └── utils/            # Logger
│   │   └── dist/               # Build output
│   └── web/                  # React frontend (port 5173)
│       ├── src/
│       │   ├── api.ts            # Fetch client with VITE_API_URL
│       │   ├── App.tsx           # Main component, hash-route workflow
│       │   ├── selection.ts      # Selection state machine
│       │   ├── workflow.ts       # Workflow state management
│       │   ├── components/       # UI components
│       │   └── test/             # Web tests
│       └── dist/               # Build output
├ packages/
│   └── shared/               # Shared Zod schemas and types
│       ├── schemas.ts          # Zod validation schemas
│       ├── types.ts            # Type interfaces
│       └── index.ts            # Re-exports
├ .env                        # Environment variables (not committed)
├ .env.example                # Example env configuration
├ package.json                # Monorepo config (workspaces: apps/*, packages/*)
├ package-lock.json
├ tsconfig.base.json
├ README.md                   # This file
├ LICENSE
├ MONGODB-DNS-DIAGNOSTIC-REPORT.md
├ MONGODB-DNS-IMPLEMENTATION-REPORT.md
├ MONGODB-DNS-TARGET-VERIFICATION.md
├ PHASE_2_COMPLETION.txt
└ data/                       # SQLite DB file (generated at startup, apps/api/data/)
```

---

## Environment Configuration

### Frontend Build-Time Variables (exposed to browser)

| Variable | Purpose | Required | Consumed By |
|---|---|---|---|
| `VITE_API_URL` | Base URL prepended to all API fetch paths | Optional (empty string preserves Vite proxy for local dev) | `src/api.ts` `request()` function |
| `VITE_PAYPAL_CLIENT_ID` | PayPal SDK client ID | Optional — sandbox credentials required for end-to-end payment flow | PayPal SDK initialization in `App.tsx` |
| `NODE_ENV` | Affects cookie security settings (production vs development) | Required | Vite, Express session cookie config |

### Backend Runtime Variables (server-side only, never bundled to browser)

| Variable | Purpose | Required | Consumed By |
|---|---|---|---|
| `AUTH_INITIAL_EMAIL` | Operator-provisioned account email | Required if initial account needed at startup | `startup.ts` `provisionInitialAuth()` |
| `AUTH_INITIAL_PASSWORD` | Operator-provisioned account password | Required if initial account needed at startup | `startup.ts` `provisionInitialAuth()` |
| `AUTH_COOKIE_SECURE` | Session cookie Secure flag | Optional — defaults to `true` in production, `false` in dev | `config.authCookieSecure` |
| `AUTH_COOKIE_SAMESITE` | Session cookie SameSite attribute | Optional — defaults to `'strict'`; set to `'none'` for production cross-site (must accompany `AUTH_COOKIE_SECURE=true`) | `config.authCookieSameSite`; used in `buildSessionCookieOptions()` and logout `clearCookie()` |
| `WEB_ORIGIN` | Frontend URL for CORS origin check | Required for CORS; `null` disables CORS in production | `cors()` in `src/index.ts`; `config.webOrigin` in CSRF middleware |
| `CORS_ORIGIN` | Explicit CORS origin override | Optional — if `null`, origin is derived from `WEB_ORIGIN` and `Host` header | `cors()` in `src/index.ts` |
| `VITE_API_URL` | Alias for production API base URL | Optional (same as above, via `process.env`) | Also read by Vite config |
| `PAYPAL_CLIENT_ID` | PayPal Sandbox client ID | Required for end-to-end payment flow | Forwarded to browser as `VITE_PAYPAL_CLIENT_ID` |
| `PAYPAL_CLIENT_SECRET` | PayPal Sandbox client secret | Required for order creation on server | `PayPalClient` — never bundled to browser |
| `OPENROUTER_API_KEY` | OpenRouter LLM API key | Required for AI intent parsing | `AIService` — server-side only |
| `OPENROUTER_MODEL` | OpenRouter model name | Optional — defaults to `openai/gpt-4o-mini` | `AIService` |
| `CHANNEL3_API_KEY` | Channel3 product discovery API key | Required for live Channel3 discovery | `DiscoveryFlowService` — server-side only |
| `PERSISTENCE_PROVIDER` | Persistence provider: `sqlite` or `mongodb` | Required — determines all subsequent config | `resolvePersistenceProvider()`; all repository accessors |
| `MONGODB_URI` | MongoDB Atlas connection string | Required if `PERSISTENCE_PROVIDER=mongodb` | `startup.ts` `connectMongo()`, all MongoDB repository accessors |
| `MONGODB_DB` | MongoDB database name | Required if `PERSISTENCE_PROVIDER=mongodb` | All MongoDB repository accessors |
| `DISCOVERY_PROVIDER` | `demo` or `channel3` | Optional — defaults to `demo` | `resolveDiscoveryProvider()`; product discovery route |
| `RETAILER_HANDOFF_ENABLED` | Enable retailer handoff feature | Optional — defaults to `false` | `products.ts` `/handoff` route; `config.retailerHandoffEnabled` |
| `CHANNEL3_ALLOWED_LINK_HOSTS` | Allowed Channel3 tracking hosts | Optional — defaults to `buy.trychannel3.com` | `RetailerHandoffService`; validates URL safety |
| `PAYPAL_BASE_URL` | PayPal API base URL | Optional — defaults to `https://api-m.sandbox.paypal.com` | `OrderCreationService` |
| `PAYPAL_RETURN_URL` | PayPal return URL after approval | Optional — defaults to `http://localhost:5173/#/payment/return` | `OrderCreationService` |
| `PAYPAL_CANCEL_URL` | PayPal cancel URL after cancellation | Optional — defaults to `http://localhost:5173/#/payment/cancel` | `OrderCreationService` |
| `PORT` | API server port | Optional — defaults to `3001` | `config.port` in `src/index.ts` |
| `DB_PATH` | SQLite DB file path | Optional — defaults to `./data/agentproof.db` | `startup.ts` `initDb()` |

### Environment Precedence

- `process.env` takes precedence over `.env` file values for all Vite-processed variables (`VITE_PAYPAL_CLIENT_ID`, `VITE_API_URL`)
- The repo-root `.env` is the single source of truth for local-development fallbacks
- Render dashboard variables override `.env` values

---

## Local Development Setup

### Prerequisites

- Node.js >= 22.0.0
- PayPal Sandbox account (for end-to-end payment flow)
- OpenRouter API key (for AI intent parsing, optional if using pre-structured intents)
- Channel3 API key (for live discovery, optional if using demo catalog)
- Git

### Installation

```bash
npm install
```

### Environment Configuration

Create `.env` at the repository root:

```dotenv
# Required for the authenticated UI flow (both must be set together)
AUTH_INITIAL_EMAIL=you@example.com
AUTH_INITIAL_PASSWORD=<at-least-12-characters>
WEB_ORIGIN=http://localhost:5173

# Discovery source (choose one)
DISCOVERY_PROVIDER=demo
# or for live Channel3:
# DISCOVERY_PROVIDER=channel3
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

**Important**: `PAYPAL_CLIENT_ID` is forwarded to the browser for the PayPal SDK. All other credentials remain server-side only.

### Start the Services (separate terminals)

```bash
npm run dev:api   # starts Express on http://localhost:3001
npm run dev:web   # starts Vite on http://localhost:5173
```

### Open the App

Navigate to `http://localhost:5173`, sign in with the provisioned account, and complete the workflow.

### SQLite Database Location

The default `DB_PATH=./data/agentproof.db` resolves relative to the API working directory (`apps/api`), producing `apps/api/data/agentproof.db`. The path is created automatically on first startup; an existing file is loaded and migrated; empty or corrupt files fail startup.

### MongoDB Atlas Setup

To select MongoDB explicitly:

```dotenv
PERSISTENCE_PROVIDER=mongodb
MONGODB_URI=mongodb+srv://<username>:<password>@<cluster-host>/?retryWrites=true&w=majority
MONGODB_DB=agentproof
```

A startup DNS fix is required on Windows: the process-level `dns.setServers(['8.8.8.8'])` in `startup.ts` enables Atlas SRV resolution. On Linux/macOS, the system DNS resolver typically handles SRV records without additional configuration.

---

## Testing and Build Commands

| Command | Scope |
|---|---|
| `npm run build` | Build all packages and apps (shared → api → web) |
| `npm run typecheck` | Type-check all packages and apps |
| `npm run test:api` | API test suite (Vitest) — 675+ tests |
| `npm run test:web` | Frontend test suite (Vitest + React Testing Library) — 72 tests |
| `npm test` | Run both API and web test suites |

### API Tests

- 675+ tests across: repository contracts, service logic, route handlers, cross-user regression
- Cross-user tests use in-memory repo pattern to avoid SQLite initDb() blocker
- 1 pre-existing failure: `persistenceProvider.test.ts` expects `sqlite` but env has `mongodb` configured (environment-dependent)

### Web Tests

- 72 tests across: selection, workflow, API auth, API history, router, api selection, api auth, api handoff

### TypeScript Build Fix

`"exclude": ["**/*.test.ts", "**/*.spec.ts"]` added to `apps/api/tsconfig.json` so that `tsc --noEmit` does not compile test files, eliminating diagnostic errors in `cross-user-regression.test.ts`.

---

## Production Deployment

### Render / Production Checklist

1. **Set `NODE_ENV=production`** — this prunes devDependencies and affects cookie security settings
2. **Persistence provider** — default is `sqlite`; to use MongoDB, set `PERSISTENCE_PROVIDER=mongodb` with valid `MONGODB_URI` and `MONGODB_DB`
3. **DNS fix for MongoDB** — on Windows, the process-level `dns.setServers(['8.8.8.8'])` in `startup.ts` enables Atlas SRV resolution. On Linux/macOS, the system DNS resolver typically handles SRV records correctly.
4. **Environment variables** — all secrets (`MONGODB_URI`, `OPENROUTER_API_KEY`, `PAYPAL_CLIENT_SECRET`, `CHANNEL3_API_KEY`) must be set as Render environment variables, never in the codebase
5. **CORS** — set `WEB_ORIGIN` to the production frontend URL; `CORS_ORIGIN` can be set to `null` to disable CORS in production
6. **Cookie security** — `AUTH_COOKIE_SECURE` defaults to `true` in production; ensure the deployment uses HTTPS. Set `AUTH_COOKIE_SAMESITE=none` on Render dashboard for cross-site cookie support (SameSite=None requires Secure=true).
7. **No automatic startup provisioning** — the operator must ensure `AUTH_INITIAL_EMAIL` and `AUTH_INITIAL_PASSWORD` are set if an initial account is needed at startup
8. **VITE_API_URL** — set to the production API URL on the frontend workspace, e.g., `VITE_API_URL=https://agentproof-api-y6ns.onrender.com`
9. **VITE_PAYPAL_CLIENT_ID** — set to the PayPal Sandbox client ID on the frontend workspace

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

## Actual Current Limitations

- **No public registration, password reset, or account management UI** — accounts are operator-provisioned only (via `AUTH_INITIAL_EMAIL` + `AUTH_INITIAL_PASSWORD` at startup)
- **SQLite is a single-process store** — do not run multiple API processes against the same `DB_PATH`; they race on whole-file replacement
- **PayPal completion requires operator-supplied Sandbox credentials** — no end-to-end verification without them
- **Channel3 provides product discovery and server-verified handoff URLs only** — integrated checkout is not implemented; opening the retailer URL completes the purchase outside AgentProof
- **MongoDB Atlas requires explicit configuration and DNS fix** (Windows: `dns.setServers(['8.8.8.8'])` at startup)
- **No background reconciliation worker** — completed-transaction evidence is reconciled on the next capture retry or explicit action
- **Prices and availability are snapshotted at discovery time** — re-discovery required for current data
- **Compound intents (multiple product categories)** are not supported — each request must request one product category
- **No session cleanup job for SQLite** — expired rows are ignored by active lookup but not physically deleted
- **Legacy ownerless data** (pre-P5) is intentionally hidden from normal users; trusted operator path required for migration
- **No WAL or multi-writer coordination** for SQLite — one API process per `DB_PATH`
- **AUTH_COOKIE_SAMESITE requires manual configuration** for production cross-site: set `AUTH_COOKIE_SAMESITE=none` on Render/dashboard and ensure `AUTH_COOKIE_SECURE=true` (the default in production)

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