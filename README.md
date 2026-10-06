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

## Phase 1 Scope (Current)

Phase 1 proves the core domain loop:

- Intent data → deterministic Policy Engine → ALLOW/DENY → financial state transition → per-action authority state → append-only evidence → API response

### What is implemented:

- ✅ Structured intent model with Zod validation
- ✅ Deterministic Policy Engine (PRICE, BRAND, CONDITION, PURPOSE, CONFIRMATION_THRESHOLD rules)
- ✅ Financial state machine (INTENT_CREATED → ... → RESOLVED)
- ✅ Per-action authority state machine (independent of financial state)
- ✅ Append-only SQLite evidence ledger with explicit provenance
- ✅ REST API (POST /intent, POST /policy/evaluate, GET /evidence)
- ✅ Minimal React frontend shell
- ✅ Comprehensive unit tests

### What is NOT yet implemented:

- ❌ OpenRouter integration (LLM intent parsing)
- ❌ PayPal Sandbox integration
- ❌ Channel3 product discovery
- ❌ Elasticsearch evidence search
- ❌ AG Grid / Bryntum visualization
- ❌ Dispute flow
- ❌ Full UI dashboard
- ❌ Human approval gate UI

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

### Phase 1 Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check |
| POST | `/api/v1/intent` | Create a structured intent |
| GET | `/api/v1/intent/:id` | Retrieve an intent |
| POST | `/api/v1/policy/evaluate` | Evaluate a product against an intent |
| GET | `/api/v1/evidence` | Retrieve evidence records |
| GET | `/api/v1/evidence/:id` | Retrieve a single evidence record |

## Technology Stack

- **Frontend:** React, TypeScript, Vite, Tailwind CSS
- **Backend:** Node.js 22, Express, TypeScript
- **Validation:** Zod
- **Database:** SQLite (via better-sqlite3)
- **Testing:** Vitest
- **AI:** OpenRouter (coming in Phase 2)
- **Payments:** PayPal Sandbox (coming in Phase 4)

## Environment Variables

See `.env.example` for the full list. Phase 1 requires no external service credentials.

## Current Limitations

- No LLM integration — intents must be provided as structured JSON
- No PayPal integration — no real transactions
- No product discovery — products must be provided in policy evaluation requests
- No UI dashboard — minimal shell only
- Single-user, no authentication
- SQLite only (no concurrent write support)

## Next Phase

Phase 2: OpenRouter integration for natural-language intent parsing.
