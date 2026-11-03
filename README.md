# AgentProof

Audit and control layer for agentic commerce.

## What is AgentProof?

AgentProof is a web application for the PayPal AI Hackathon that ensures every financial action taken by an AI agent is:

1. **Authorized** by explicit user intent
2. **Constrained** by deterministic policy
3. **Permitted or denied** according to current financial state
4. **Executed** through PayPal Sandbox
5. **Recorded** as auditable evidence
6. **Explainable** after the fact
7. **Protected** by backend-enforced human approval for consequential actions

## Current Architecture

```
User Intent → LLM (OpenRouter) → Structured Intent → Policy Engine → ALLOW/DENY → PayPal Sandbox → Evidence
```

**Key principle:** The LLM may reason and propose actions. The LLM must **never** be the final authority for financial actions. The deterministic Policy Engine is the sole authority.

## Current Scope (P6)

P6 completes the authenticated end-to-end demo loop and makes saved workflows refresh-safe:

- Structured intent → deterministic policy → discovery → PayPal order/capture → evidence → persisted history
- Per-user workflow history is read from the existing repositories, not from browser storage
- The UI restores a selected workflow from `#/?intent=<intent-id>` after a refresh
- A verified PayPal return links back to that saved workflow
- Payment status always comes from the persisted transaction; evidence completeness is shown explicitly

### Implemented

- ✅ Structured intent model with Zod validation and OpenRouter parsing
- ✅ Deterministic Policy Engine (PRICE, BRAND, CONDITION, PURPOSE, CONFIRMATION_THRESHOLD rules)
- ✅ Channel3 or explicit demo product discovery
- ✅ PayPal Sandbox order creation, capture verification, and idempotent retry
- ✅ Append-only, owner-scoped evidence ledger with bounded completion-evidence recovery
- ✅ SQLite by default and MongoDB Atlas explicitly opt-in, with no silent fallback
- ✅ Operator-provisioned accounts, HttpOnly server-side sessions, CSRF/CORS checks
- ✅ Persisted per-user workflow, transaction, discovery, and evidence history
- ✅ Responsive React UI for the full workflow, including loading/empty/error states
- ✅ Unit, repository-contract, API, and frontend tests

### Not implemented

- ❌ Public registration, password reset, account management, or session-management UI
- ❌ Elasticsearch evidence search
- ❌ AG Grid / Bryntum visualization
- ❌ Dispute flow
- ❌ Additional roles or multi-tenant administration

## Project Structure

```
agentproof/
├── apps/
│   ├── api/              # Express backend
│   └── web/              # React frontend
├── packages/
│   └── shared/           # Shared Zod schemas and types
├── docs/                 # Architecture documentation
└── README.md
```

## Installation

```bash
npm install
```

## Running the Application

### API (port 3001)

```bash
npm run dev:api
```

### Web (port 5173)

```bash
npm run dev:web
```

### Tests

```bash
npm test
```

## API Endpoints

### Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | Public | Health check |
| POST | `/api/v1/auth/login` | Public | Exchange email/password for an HttpOnly session cookie |
| POST | `/api/v1/auth/logout` | Public | Revoke the current session and clear the cookie |
| GET | `/api/v1/auth/session` | Required | Return the authenticated user and session expiry |
| POST | `/api/v1/intent` | Required | Create a structured intent owned by the caller |
| GET | `/api/v1/intent` | Required | List the caller's saved intents, newest first (`limit`, max 50) |
| GET | `/api/v1/intent/:id` | Required | Retrieve one of the caller's intents |
| POST | `/api/v1/policy/evaluate` | Required | Evaluate a product against the caller's intent |
| POST | `/api/v1/products/discover` | Required | Discover products for the caller's intent |
| GET | `/api/v1/products/discoveries/:intentId` | Required | Restore saved discovery snapshots and policy evaluations for an owned intent |
| POST | `/api/v1/payments/create-order` | Required | Create a PayPal order for the caller's intent/product |
| POST | `/api/v1/payments/capture` | Required | Capture the caller's approved order (safe to retry) |
| GET | `/api/v1/payments/history` | Required | List the caller's transactions, newest first (`intentId`, `limit`) |
| GET | `/api/v1/payments/by-order/:orderId` | Required | Look up the caller's transaction by PayPal order id |
| GET | `/api/v1/evidence` | Required | List the caller's evidence (`intentId`/`transactionId` filters) |
| GET | `/api/v1/evidence/:id` | Required | Retrieve one of the caller's evidence records |

## Technology Stack

- **Frontend:** React, TypeScript, Vite, plain CSS
- **Backend:** Node.js 22, Express, TypeScript
- **Validation:** Zod
- **Database:** SQLite (sql.js) by default; MongoDB Atlas opt-in (`PERSISTENCE_PROVIDER`)
- **Testing:** Vitest
- **AI:** OpenRouter for intent parsing
- **Payments:** PayPal Sandbox / Web SDK v6
- **Discovery:** Channel3, or the explicit `demo` catalog for local development

## Local Operator Setup (P6)

No `.env` file is included in the repository. The operator creates it from
`.env.example`; never commit real credentials. The following values are required
for the full authenticated UI flow.

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create the local env file:

   ```bash
   cp .env.example .env
   ```

   On Windows PowerShell use `Copy-Item .env.example .env`.

3. Provision the single local account. Set **both** values together in `.env`:

   ```dotenv
   AUTH_INITIAL_EMAIL=you@example.com
   AUTH_INITIAL_PASSWORD=<at-least-12-characters>
   WEB_ORIGIN=http://localhost:5173
   ```

   Startup creates the account once. Re-running never modifies or resets an
   existing account. There is no registration route, password-reset flow, or
   account-management UI.

4. Choose exactly one discovery source:

   ```dotenv
   DISCOVERY_PROVIDER=demo
   ```

   or, for live Channel3 discovery:

   ```dotenv
   DISCOVERY_PROVIDER=channel3
   CHANNEL3_API_KEY=<server-side-channel3-key>
   ```

   An empty `DISCOVERY_PROVIDER` defaults to Channel3. A live-provider failure is
   reported as an error; it never silently falls back to demo data.

5. For natural-language intent parsing, set:

   ```dotenv
   OPENROUTER_API_KEY=<server-side-openrouter-key>
   OPENROUTER_MODEL=openai/gpt-4o-mini
   ```

   Without this key, `POST /api/v1/intent` cannot parse free-form input. The API
   still accepts a pre-structured intent payload, but the bundled UI submits raw
   text.

6. For the full PayPal flow, use credentials from a PayPal Sandbox app:

   ```dotenv
   PAYPAL_CLIENT_ID=<sandbox-client-id>
   PAYPAL_CLIENT_SECRET=<sandbox-client-secret>
   PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com
   PAYPAL_RETURN_URL=http://localhost:5173/#/payment/return
   PAYPAL_CANCEL_URL=http://localhost:5173/#/payment/cancel
   ```

   `PAYPAL_CLIENT_ID` is intentionally forwarded to the browser by
   `apps/web/vite.config.ts` for the PayPal SDK. `PAYPAL_CLIENT_SECRET`,
   `OPENROUTER_API_KEY`, `CHANNEL3_API_KEY`, and `MONGODB_URI` remain server-side.

7. Persistence is SQLite by default:

   ```dotenv
   PERSISTENCE_PROVIDER=sqlite
   ```

   To select MongoDB explicitly, set both values; startup fails closed if they
   are missing or unusable:

   ```dotenv
   PERSISTENCE_PROVIDER=mongodb
   MONGODB_URI=mongodb+srv://<user>:<password>@<cluster-host>/?retryWrites=true&w=majority
   MONGODB_DB=agentproof
   ```

8. Start the API and web app in separate terminals:

   ```bash
   npm run dev:api
   npm run dev:web
   ```

9. Open `http://localhost:5173`, sign in with the provisioned account, create an
   intent, and complete the workflow. The saved workflow remains available after
   a browser refresh. With the default SQLite provider it is also loaded after an
   API restart from `apps/api/data/agentproof.db` (the default `DB_PATH`, resolved
   from the API working directory).

**Live PayPal verification blocker:** this repository does not contain PayPal
Sandbox credentials and no external service was contacted during implementation.
A real payment/capture can only be verified after the operator provisions a
Sandbox app and account with the variables above. Missing credentials must be
reported as a configuration blocker, not bypassed with fake success states.

## Environment Variables

See `.env.example` for the complete annotated list. The local operator must
provide the values described above; the defaults keep SQLite and never silently
switch providers.

## Current Limitations

- No public registration, password reset, password rotation, or session-management
  UI; accounts are provisioned by the operator.
- Default SQLite uses an in-process `sql.js` database. It now flushes a complete
  snapshot to `DB_PATH` after each mutation and on shutdown using an atomic
  replace, but it remains a single-process store: do not run multiple API
  processes against the same database file. MongoDB is explicit opt-in.
- PayPal completion can only be verified end-to-end with operator-supplied
  Sandbox credentials and a provisioned Sandbox account.
- Saved discovery history contains shared-offer snapshots and their owner-scoped
  policy evaluations. Rejected candidates were never persisted as reconstructable
  offers, so re-running discovery is required to review denied current offers.
- There is no background reconciliation worker. Completed-transaction evidence is
  reconciled on the next safe capture retry or explicit check-evidence action.

## Evidence recovery (P2-C)

- Post-capture evidence uses deterministic IDs (`ev:<transactionId>:<eventType>`) and atomic insert-if-absent writes. Retries and concurrent writers cannot create duplicates or overwrite an existing record.
- If evidence persistence fails after a durable payment completion, the capture still returns `PAYMENT_COMPLETED` with `evidenceIncomplete: true` and `evidenceStatus: "RECOVERY_PENDING"`; raw database errors are never returned to clients.
- Recovery is bounded and requires a persisted `PAYMENT_COMPLETED` transaction with a PayPal order id. It is attempted when a capture reports incomplete evidence and when an already-completed transaction is retried. It never calls PayPal, never repeats the state transition, and only writes the missing completion events supported by persisted order/capture data.
- Recovery is best-effort, not crash-guaranteed: a completed transaction with missing evidence is reconciled on the next completed-capture retry, or by calling `EvidenceService.recoverCompletionEvidence` from a trusted reconciliation path.

## Product and discovery persistence (P3)

- Shared provider offers are stored once per `(source, productId)`. Product ids are provider-local, so the provider identity is always part of the key.
- Per-intent discovery associations are stored independently under `(intentId, source, productId)`. Two intents can discover the same product without overwriting each other, and re-discovery is an idempotent update for that one intent.
- Refreshing a shared offer updates only the offer. It never deletes or rewrites any intent's discovery association.
- `sqlite` (default) keeps offers in the existing `products` table and associations in the new `intent_discoveries` table.
- `mongodb` (opt-in) stores offers in `offers` and associations in `intentDiscoveries`. Startup creates the P3 indexes alongside the P2-B and P4 indexes.
- P3 indexes:
  - `offers`: unique `uniq_source_product` on `{source: 1, productId: 1}`
  - `intentDiscoveries`: unique `uniq_intent_provider_product` on `{intentId: 1, source: 1, productId: 1}`, plus `by_intent_recent` on `{intentId: 1, discoveredAt: -1}`
- Selecting `mongodb` migrates product and discovery persistence as well; there is no hybrid product store. Connection or index failure aborts startup and never falls back to SQLite.
- **Consistency limitation:** an offer and its per-intent association are separate documents written without a cross-collection transaction. If the association write fails after the offer write, the request fails and the refreshed ownerless offer remains; this is not reported as success. The legacy SQLite `products.id` primary key also means provider-distinct offers sharing an id remain a SQLite-only limitation.

## Users and sessions persistence (P4)

- P4 added only the persistence foundation for accounts and server-side sessions. P5 builds the authentication and ownership layer on top of these repositories.
- `sqlite` (default) stores accounts in `users` and sessions in `sessions`.
- `mongodb` (opt-in) stores accounts in `users` and sessions in `sessions`. Startup creates the P4 indexes after the P2-B and P3 indexes; a connection or index failure aborts startup with no SQLite fallback.
- Email addresses are trimmed and lower-cased before storage and lookup. Uniqueness is enforced on that normalized value (`users.uniq_email`).
- Only `passwordHash` is stored; the repository never stores plaintext passwords. Normal user reads omit the hash; the explicit `getCredentialsByEmail` lookup is used only by the server-side login verification path.
- Only a caller-supplied `tokenHash` is stored, never the raw bearer token. Sessions carry `expiresAt` and an optional `revokedAt`; active lookup enforces both even though MongoDB TTL deletion is asynchronous.
- P4 indexes:
  - `users`: unique `uniq_email` on `{email: 1}`
  - `sessions`: unique `uniq_token_hash` on `{tokenHash: 1}`, `by_user` on `{userId: 1}`, and TTL `ttl_expires` on `{expiresAt: 1}` with `expireAfterSeconds: 0`
- MongoDB `expiresAt`/`revokedAt` are BSON `Date` values; SQLite stores ISO timestamps.
- **Limitation:** no session cleanup job exists for SQLite; expired rows are ignored by active lookup. MongoDB relies on the TTL monitor and still checks expiry in application code.

## Authentication, ownership, and scoped evidence (P5)

- **No public registration.** The operator provisions the initial account at startup with `AUTH_INITIAL_EMAIL` and `AUTH_INITIAL_PASSWORD`. Both must be set together; the password must be at least 12 characters. Provisioning is idempotent: an existing account is never modified or re-created. Neither the password nor its hash is logged.
- **Passwords are never stored in plaintext.** Password hashes use Node's built-in `crypto.scrypt` with a fresh random salt per password and constant-time verification. Unknown emails still perform a dummy verification to reduce account-enumeration timing differences. Login failures always return the same generic `401 Invalid email or password`.
- **Server-side sessions.** A login issues 32 cryptographically random bytes (base64url) as the bearer value. Only its SHA-256 hash is persisted; the raw token is never stored or returned in JSON. The token is delivered in the `agentproof_session` cookie with `HttpOnly`, `SameSite=Strict`, `Path=/`, and `Secure` controlled by `AUTH_COOKIE_SECURE` (default: on in production, off otherwise). Active lookup enforces `expiresAt` and `revokedAt`; logout revokes the session and clears the cookie.
- **Ownership comes from the session only.** Intents, policy evaluations, transactions, and evidence records carry the authenticated user id; intent-discovery associations are reachable only after the owning intent is verified. Client-supplied `userId` fields are ignored. Discovery and order creation resolve the caller's persisted intent (and its stored structured intent) rather than trusting client-supplied intent context. Product price/currency/merchant data is resolved from the server-side discovery snapshot.
- **No cross-user access or existence leak.** List/filter/get operations are scoped to the caller. Unknown ids and another user's ids both return `404`; a scoped list with no matches returns an empty array. Payment capture and PayPal order lookup are owner-scoped.
- **Legacy ownerless rows stay inaccessible.** Rows written before P5 (NULL/missing `userId`) are not exposed to ordinary users and are not backfilled automatically. A trusted recovery/maintenance path can still address them through the unscoped internal repository methods.
- **Evidence remains append-only and fully scoped.** `GET /api/v1/evidence` accepts only the caller's records, and `intentId`/`transactionId` filters cannot widen access. `GET /api/v1/evidence/:id` returns `404` for ownerless or foreign records. Deterministic completion ids (`ev:<transactionId>:<eventType>`) and insert-if-absent recovery semantics are unchanged.
- **CSRF/CORS.** CORS uses the explicit `WEB_ORIGIN` with `credentials: true` (never a wildcard). State-changing requests with an `Origin`/`Referer` header must match `WEB_ORIGIN` or the request's own host; the session cookie is also `SameSite=Strict`. Non-browser clients without either header are not blocked by the CSRF middleware.
- **Frontend.** The web app probes `/api/v1/auth/session` on load, shows a sign-in screen when unauthenticated, sends cookies with every API request (`credentials: 'include'`), returns to sign-in on an expired-session `401`, and renders clear `403` authorization messages. No token is kept in browser storage.

### P5 limitations

- Only the operator-provisioned account exists, and no API creates additional accounts; there is no registration, reset, or password-change flow.
- SQLite sessions are ignored after expiry but are not physically deleted; MongoDB uses a TTL index and still checks expiry in application code.
- Legacy ownerless data must be migrated or handled by a trusted operator path; it is intentionally hidden from normal users.

## Persisted workflow and history (P6)

- **One source of truth.** Saved workflows come from the existing user-scoped
  intent, transaction, policy-evaluation, and discovery repositories. There is no
  second datastore, no browser-storage fallback, and no client-supplied ownership.
- **History endpoints.** `GET /api/v1/intent` lists the caller's intents newest
  first; `GET /api/v1/payments/history` lists the caller's transactions and
  accepts an optional `intentId` filter; `GET /api/v1/products/discoveries/:intentId`
  restores saved offers after verifying intent ownership. The two history lists
  cap `limit` at 50; history filters cannot widen ownership and return an empty
  list, while a foreign or unknown discovery intent returns `404`.
- **Restore after refresh.** The UI uses hash-query rehydration
  (`#/?intent=<id>`) to load the intent, saved discovery/policy state, latest
  persisted transaction, and evidence. A valid session restores the workflow
  without re-running discovery or trusting stale client objects.
- **Payment truth.** Pending/completed payment display is derived from the
  persisted `Transaction`, not from a transient PayPal response. A successful
  capture refreshes the saved transaction and evidence; an ambiguous verification
  error is reported as unconfirmed, never as a failed payment.
- **Completion evidence.** Expected completion events are
  `PAYMENT_COMPLETED` plus `PAYPAL_PAYMENT_CAPTURED`/`PAYMENT_CAPTURED` when a
  capture id exists. Missing evidence is shown as an explicit incomplete state
  with a reconcile action. Reconcile reuses the idempotent capture endpoint, which
  performs bounded recovery without calling PayPal for an already-completed
  transaction.
- **Honest restoration limits.** Only server-persisted approved offer snapshots
  can be shown; retained offers may come from earlier discovery runs or an earlier
  provider configuration. Rejected candidates were not stored as offers, so the
  restored panel says so and offers "Re-run discovery" to evaluate current prices.
  Order creation still resolves only through the active provider, enforces the
  snapshot freshness window, and re-evaluates policy server-side.
- **PayPal return.** `#/payment/return` resolves the order, verifies capture, and
  distinguishes completed, already-completed, cancelled, and unconfirmed
  outcomes. It redirects back with a hash route so no server-side rewrite is
  required.

## SQLite durability lifecycle (P6 follow-up)

- **Existing file first.** `initDb()` loads `DB_PATH` when the file exists and
  creates a new database only when it does not. An empty or corrupt existing file
  fails startup instead of being replaced, and the file is left untouched.
- **Migration is persisted.** The existing schema/migration path runs first. The
  migrated snapshot is then written before the API starts serving, so a new
  database file and any ownership-column migrations are durable immediately.
- **Write-through persistence.** `sql.js` holds the database in memory. The
  wrapper in `apps/api/src/models/db.ts` flushes the full database after every
  mutating `run`, `exec`, or prepared `run` call. A successful repository write
  is therefore on disk before the caller receives success; it is not deferred
  until shutdown.
- **Atomic file replacement.** Each flush writes a unique temporary file in the
  database directory, fsyncs it, and renames it over `DB_PATH`. A failure leaves
  the previous database intact and removes the temporary file. Empty exports are
  rejected. POSIX also fsyncs the parent directory; Windows relies on the
  filesystem after flushing the file.
- **Shutdown and startup provisioning.** Normal SIGINT/SIGTERM shutdown closes
  the HTTP server and calls `closeDb()`, which saves again and closes the handle.
  An existing user is found on the next startup, so provisioning does not reset
  its password or recreate the account.
- **Single-writer trade-off.** Every mutation rewrites the whole SQLite file.
  That favors simplicity and correctness for this local demo, not high write
  throughput. One API process per `DB_PATH` is required; concurrent processes
  would race on whole-file replacement. There is no WAL mode or multi-writer
  coordination.
- **Default location.** With the workspace scripts, the API working directory is
  `apps/api`, so the default `DB_PATH=./data/agentproof.db` resolves to
  `apps/api/data/agentproof.db`. The path is relative to the API process working
  directory.

## Next Phase

P6 is the current completed scope. P7 and later are not implemented.

## Roadmap

Planned capabilities that go beyond the current P6 scope:

- **Personalised shopping preferences** — user-configurable preferences for product categories, price ranges, and brands.
- **Daily personalised product updates** — curated product recommendations based on saved preferences and discovery history.
- **Price and availability change notifications** — alerts when monitored products change price or become available.
- **Trend-based discovery** — when reliable popularity data is available, feature products with rising interest.
- **Channel3 checkout capability** — investigation of deeper Channel3 integration for completing purchases within the workflow; not currently implemented.
- **Additional retailer integrations** — supporting outbound links to additional merchant platforms beyond Channel3.
- **Future PayPal-connected purchasing workflows** — beyond the current Sandbox verification, exploring end-to-end PayPal-connected purchase flows that remain explicitly authorized by the user.

All future roadmap items are aspirational and will be implemented only after explicit approval. None of the above should be described as completed or guaranteed functionality. Consequential financial actions must always require explicit user authorization.
