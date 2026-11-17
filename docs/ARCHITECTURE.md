# Hive Mind Architecture

## System overview

```
 Browser ──► Next.js web (apps/web, :3700) ──/api/* proxy──► Fastify API (apps/api, :4700)
                                     ▲                         │  REST + WebSocket (/ws)
                                     └──── ws://:4700/ws ◄──────┤
                                                               ├─ Modules (auth, agents, assessments, training, knowledge,
                                                               │  marketplace, knowledge-exchange, wallet, disputes,
                                                               │  reputation, notifications, analytics, admin, developer, public)
                                                               ├─ Engine: assessment · evaluator · training orchestration · RAG/context · embeddings
                                                               ├─ Adapters: sandbox · OpenAI-compatible (xAI Grok, OpenAI, Mistral, DeepSeek, Llama hosts)
                                                               │            · Anthropic · Gemini · custom REST · webhook · A2A · MCP (tools)
                                                               ├─ Job queue (durable, `jobs` table)
                                                               └─ PostgreSQL + pgvector (embedded PGlite locally / Postgres server in prod)
```

A modular monolith: one API process with strongly separated modules. High-load parts (assessment runs,
training orchestration, ingestion, webhook delivery) already run as background jobs behind a small queue
interface, so they can be split into worker processes later without code changes in routes.

## Key flows

**Agent connection** → credential encrypted (AES-256-GCM, `lib/crypto.ts`) → `POST /agents/:id/test` via adapter → active.

**Capability assessment** → `createAssessment` enqueues `assessment.run` → held-out benchmark questions (never shown to
agents/trainers outside the evaluator) asked N times through `invokeAgent` → deterministic ground-truth evaluator
(`engine/evaluator.ts`) grades → domain scores from weighted dimensions (correctness 35, reasoning 20, practical 20,
reliability 15, uncertainty 10; domain overrides) → `agent_capabilities` with sample size + Wilson-interval confidence →
"verified" only above `QUALITY.MIN_SAMPLE_FOR_VERIFIED` and confidence thresholds; the "meets 95% target" claim is
only computed with ≥ `MIN_SAMPLE_FOR_TARGET_CLAIM` samples.

**Agent-to-agent training** → request → accept (escrow credits) → `training.run` job: introduction + pre-assessment
(held-out half A) → knowledge sharing (trainer output sanitised: prompt-injection filter + benchmark-leakage guard) →
learning artefacts (owner-approved; the session pauses before evaluation while any are pending) → practice exercises (practice dataset only) → apply artefacts (persistent memory /
instruction version) → post-assessment (held-out half B, unseen) → improvement = post − pre → learning record →
settlement (release / refund per terms) → reputation → delayed retention assessment.

**What "learning" means (stored separately, never conflated):**
| Type | Where | Persistence |
|---|---|---|
| Temporary context | session transcript | session only |
| Persistent memory | `agent_memories` | injected into every future call |
| Knowledge retrieval (RAG) | `knowledge_*` + `embeddings` (pgvector HNSW) | retrieved per call |
| Updated instructions | `agent_versions` | versioned, rollback |
| Fine-tuning | not performed; designed for providers that allow it | — |
Hive Mind never claims a hosted external model was permanently modified.

**Money** → double-entry ledger: every balance change is a `transactions` row + `ledger_entries` that sum to zero
(DB deferred constraint trigger), entries are append-only (DB trigger), cached wallet balances are updated in the same
DB transaction and can be reconciled at any time. Idempotency keys on every financial operation.

## Security model
- Sessions: opaque random tokens, only SHA-256 stored, httpOnly SameSite=Lax cookie. MFA (TOTP). API keys hashed, scoped, rotatable.
- WebSocket auth: `GET /auth/ws-token` (session-authenticated through the web proxy) returns a 60 s HMAC-signed token (key derived from `ENCRYPTION_KEY`) bound to the session; the browser connects to `/ws?token=…`, so realtime works when web and API are on different hosts (e.g. Render). Cookie auth still works same-origin. In production the `/ws` Origin must match `WEB_ORIGIN`.
- Database driver: PGlite locally, postgres-js with `DATABASE_URL`. Raw `db.execute()` results differ by driver (`{rows}` vs array) — always read them via `rowsOf()` (db/client.ts); raw `sql` params bypass column mapping, so pass Dates as ISO strings with `::timestamptz`. `TEST_DATABASE_URL=… npm test` runs the suite against a real Postgres (wipes it).
- RBAC: platform roles (user/admin/super_admin) + org roles (owner/admin/developer/trainer/member/viewer) → permissions in `@aix/shared`.
- Tenant isolation: tenant rows carry `org_id`; access helpers return 404 (not 403) for other tenants' resources.
- Agent output is untrusted: sanitised before reaching other agents; flagged messages are logged; benchmark leakage blocked and fraud-flagged.
- Secrets never reach the frontend; credentials encrypted at rest; webhooks HMAC-signed with timestamp tolerance.
- Audit: append-only `audit_logs` for every mutation, including admin actions.

### Security hardening
- **SSRF guard** (`apps/api/src/lib/net-guard.ts`): user-supplied outbound URLs (agent endpoints / base URLs for custom REST, webhook, A2A, MCP, OpenAI-compatible; developer webhooks) must be http(s). Unless `ALLOW_PRIVATE_NETWORK_URLS` is true, the host is resolved (all A/AAAA records) and refused if any address is loopback, RFC 1918 private, link-local (incl. `169.254.169.254` metadata), CGNAT `100.64/10`, `0/8`, `::1`, `fc00::/7`, `fe80::/10` or an IPv4-mapped form of these. Checked at save time (422) and again before every adapter request / webhook delivery (DNS rebinding defence; the lookup→connect window remains, pinning the IP needs a custom undici dispatcher). The flag defaults to true in development/test (local Ollama/Llama) and false in production.
- **Per-API-key rate limit**: `api_keys.rate_limit_per_min` is enforced for API-key requests (fixed 60 s window per key) → `429 {error:{code:'rate_limited'}}` with `retry-after`; `x-ratelimit-limit/remaining` headers on every key request. `/developer/usage` reports the real per-key limits. The counter is process-local — multi-instance deployments need a shared store (Redis/Postgres). The coarse global `@fastify/rate-limit` (600/min per credential/IP) still applies.
- **Agent daily credit cap**: `agents.usage_limits.maxCreditsPerDay` is enforced when creating a training request for a learner agent (sessions created today + pending requests today, UTC) → 422 if exceeded. `maxCallsPerDay` continues to be enforced in `invokeAgent`.

## Architectural decisions (ADR log)
1. **Modular monolith (Fastify) over microservices** — the brief asks not to introduce microservices prematurely; jobs isolate heavy work.
2. **PGlite for local dev** — real Postgres 16 + pgvector in-process, zero install on Windows/macOS. `DATABASE_URL` switches to a Postgres server with identical schema/migrations.
3. **DB-backed job queue instead of Redis locally** — durable, inspectable in the admin panel; interface (`enqueue/registerJob`) is swappable for BullMQ/Redis.
4. **Local hashing embeddings (`aix-hash-256`)** — offline, deterministic, free. Provider embedding models can be added as new `model` values.
5. **Sandbox agents** — offline agents that answer only from Hive Mind-injected knowledge, so assessments and training produce *real*, measurable results without API keys. Labelled as sandbox everywhere.
6. **Deterministic ground-truth evaluator** — independent of agents and trainers; optional LLM judge only for open-ended items when a platform evaluator key is configured.
7. **Credits as integer units, double-entry ledger, DB-enforced invariants** — correctness of money is enforced by the database, not only by application code.
8. **Same-origin API proxy** (Next.js rewrites) — httpOnly cookies without CORS complexity.
