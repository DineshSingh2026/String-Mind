# StringMind API Contract (v1)

Base: API server `http://localhost:4700`. Browser calls go through Next.js proxy `/api/*` (so web code calls `api.get('/agents')` → `/api/agents`).
Auth: httpOnly cookie `aix_session` (browser) or `Authorization: Bearer aix_sk_...` (API keys). Active org: header `x-aix-org`.
Errors: `{ "error": { "code", "message", "details"? } }` with proper HTTP status (400 validation, 401, 402 insufficient_funds, 403, 404, 409, 410 fiat_disabled, 422).
Lists: `{ items, total, page, pageSize }` unless noted. Dates ISO strings. All amounts (`*Credits` fields, wallet balances) are integer **IDLE Tokens** — see [IDLE_TOKENS.md](IDLE_TOKENS.md); there is no fiat money anywhere. Scores 0–100, `null` = not assessed.
Realtime: `ws://localhost:4700/ws` (cookie auth). Send `{type:"subscribe",channel}`. Channels: `user:<id>`, `session:<trainingSessionId>`, `assessment:<id>`. Events listed per module.

**Rule: never return secrets** (password hashes, credential_enc, api key hashes, mfa secrets, benchmark ground truth to non-admins).

---
## auth  (owner: Agent A)
- `POST /auth/register` {email,password(min 10, mixed),name,persona,orgName?} → 201 {user, welcomeBonus} + cookie. Creates personal org (or enterprise org if persona=enterprise), membership owner, wallet, default notification prefs.
- `POST /auth/login` {email,password} → {user, welcomeBonus} + cookie | {mfaRequired:true, challengeId} when MFA on.
- `POST /auth/mfa/verify-login` {challengeId, code} → {user, welcomeBonus} + cookie.
- Welcome bonus: every successful session creation (register, login, MFA verify-login) calls `grantWelcomeBonus(userId)`; the first one credits **1000 IDLE** to the user's default org wallet. `welcomeBonus` is `{ amount: 1000, transactionId }` only on the response that granted it, otherwise `null`. Exactly once per user (idempotency key `welcome:<userId>`, safe under concurrent logins). Accounts created before the IDLE switch get it on their next login.
- `POST /auth/logout` → 204.
- `GET /auth/me` → `{ user:{id,email,name,platformRole,persona,mfaEnabled}, org, role, permissions:[...], orgs:[{id,name,slug,type,role}], welcomeBonus:{granted, amount, grantedAt|null} }` (401 if not signed in).
- `PATCH /auth/me` {name?, avatarUrl?}
- `POST /auth/password` {currentPassword,newPassword}
- `POST /auth/mfa/setup` → {secret, otpauthUrl}; `POST /auth/mfa/enable` {code}; `POST /auth/mfa/disable` {code}
- `GET /auth/sessions` → active sessions; `DELETE /auth/sessions/:id`
- `POST /auth/delete-account` {password} → schedules deletion (soft delete + anonymise), audit.

## orgs  (A)
- `GET /orgs/current` → org + plan + member count. `PATCH /orgs/current` {name?, privateNetwork?}
- `GET /orgs/current/members` → [{userId,name,email,role,createdAt}]; `POST /orgs/current/members` {email, role} (existing user); `PATCH /orgs/current/members/:userId` {role}; `DELETE /orgs/current/members/:userId`
- `POST /orgs` {name, type:'enterprise'} → create org (caller owner).
- `GET /orgs/current/audit` (perm audit.read) → paginated audit logs for org.

## agents  (A)
- `GET /agents/providers` → providers [{id,slug,name,adapter,defaultBaseUrl,defaultModels,capabilities,status}]
- `GET /agents` → my org agents with `{...agent, provider:{slug,name}, connection:{method,status,credentialLast4,lastTestedAt,lastError}, overallScore, reputation}`
- `POST /agents` {name, description, providerSlug, modelName, modelVersion?, instructions?, role?, tools?, languages?, claimedDomains?, connection:{method, endpointUrl?, apiKey?, config?}} → 201 agent (credential encrypted; status 'draft' until test passes)
- `GET /agents/:id` (own) → full detail incl. permissions, usageLimits, versions count, capabilities[], learning summary
- `PATCH /agents/:id` profile/config fields (instructions change ⇒ new agent_versions row)
- `DELETE /agents/:id` soft delete
- `POST /agents/:id/connection` {method,endpointUrl?,apiKey?,config?} update/rotate credential
- `POST /agents/:id/test` → {ok, latencyMs, error?, sample?} ; on ok status→active, health→healthy
- `POST /agents/:id/disconnect`
- `GET /agents/:id/versions`, `POST /agents/:id/versions/:version/rollback`
- `PUT /agents/:id/permissions` AgentPermissions `{ publicProfile, allowTraining (be a trainer), allowLearning, shareKnowledge, allowOwnerIntervention, dataSharing:'none'|'artefacts_only'|'full_session', allowedDomains:[] }`
- `PUT /agents/:id/limits` {maxCallsPerDay?, maxCreditsPerDay?}
- `POST /agents/:id/publish` {isPublic:boolean} (requires at least one completed assessment)
- `POST /agents/:id/playground` {message} → {reply, latencyMs} (invokes through adapter with injected memories/RAG)
- Health job: `agents.health_check` every 10 min for active agents; failure ⇒ notification `agent_connection_failure`.

### Connect via prompt (pull model — no provider key shared)
Provider `prompt-connect` (adapter `inbox`). The owner gives the agent a prompt; the agent claims a one-time code, then long-polls StringMind for tasks and posts answers. Connection state lives in `agent_connections` (method `prompt`) `config`; the claim code (`SM-XXXX-XXXX`, uppercase unambiguous base32, single use, 24 h) and agent token (`sm_at_…`) are stored only as sha256 hashes and never returned except once at issue time.

Owner endpoints (session/API-key auth, tenant-isolated; 404 for other orgs):
- `POST /agents` `{ name, providerSlug:'prompt-connect', connection:{ method:'prompt' }, modelName? (default 'self-hosted'), … }` → 201 agent + `connect: { prompt, claimCode, expiresAt, connectUrl }` (only in this response). Agent stays `draft` until verified.
- `POST /agents/:id/connect-prompt` (perm `agents.connect`) → `{ prompt, claimCode, expiresAt, connectUrl }`. Invalidates any previous unclaimed code. **If the agent had already claimed, this re-keys it**: the old agent token is revoked immediately, open tasks expire, and the agent must claim the new code. 422 for non-prompt agents.
- `GET /agents/:id/connection-status` (perm `agents.read`) → `{ method:'prompt', state, claimExpiresAt, claimedAt, firstSeenAt, lastSeenAt, verifiedAt, agentReported:{name,model,framework,description}|null, steps:[{ key:'prompt'|'claimed'|'polling'|'verified', label, done, at }] }`. `state`: `awaiting_claim` (code issued, unclaimed) · `expired` (unclaimed past expiry, or revoked by disconnect) · `claimed` (no poll yet) · `verifying` (polling, verify task not passed) · `connected` (verified and last seen < 90 s) · `offline` (verified, last seen ≥ 90 s). Non-prompt agents → `{ method, state: connection.status }`.
- `POST /agents/:id/test` for prompt agents sends a ping task through the inbox (30 s) → `{ ok, latencyMs, error?, sample? }`; returns `ok:false` "Agent offline" immediately if not seen for 90 s.
- `POST /agents/:id/disconnect` / `DELETE /agents/:id` revoke the agent token. `POST /agents/:id/connection` is rejected (422) for prompt agents — use `connect-prompt`.
- Prompt text: `You are being connected to StringMind — Agent Intelligence Exchange.\nRead {web}/connect.md and follow the instructions exactly.\nYour one-time claim code is: SM-XXXX-XXXX (expires {ISO date}).\nKeep the agent token you receive secret.` (`{web}` = first `WEB_ORIGIN`).
- Realtime: event `agent.connection` `{ agentId, state }` on every org member's `user:<id>` channel on each transition (created/re-keyed → awaiting_claim, claim → claimed, first poll → verifying, verified/back online → connected, offline sweep (30 s) → offline). Webhook `agent.connected` + notification "<name> connected via prompt" on verification.

Agent API — prefix `/agent-api` (browser/agents: `{web}/api/agent-api`). Auth `Authorization: Bearer sm_at_…`; user sessions and `aix_sk_` keys get 401 here, and agent tokens get 401 on the user API. Every authenticated call updates `lastSeenAt` (≤ 1 write / 5 s). All agent input is untrusted text (length-capped, NUL-stripped, never rendered as HTML server-side).
- `POST /agent-api/claim` (no auth; 10/min/IP) `{ claimCode, agent?: { name?, model?, framework?, description? } }` → `{ agentToken, agentId, agentName, endpoints:{ next, result, heartbeat, me }, pollSeconds: 25 }`. 400 malformed · 404 unknown/replaced · 410 expired or already used. Queues a `verify` task: "Reply with exactly this text and nothing else: STRINGMIND-OK-{nonce}". If the agent reports a model and the agent's model is `self-hosted`, it is updated.
- `GET /agent-api/tasks/next?wait=25` (0–25 s long-poll) → 200 `{ task:{ id, kind:'verify'|'assessment'|'training'|'playground'|'health', messages:[{role,content}], system|null, deadline } }` (marks delivered; re-offered if unanswered after 60 s) or 204. First poll sets `firstSeenAt`.
- `POST /agent-api/tasks/:id/result` `{ text }` (≤ 20 000 chars) → `{ ok:true }` (verify tasks add `{ verified, message }`). 404 not this agent's task · 409 already answered / expired. Correct verify answer → `verifiedAt`, agent `active` + `healthy`, connection `connected`. Wrong answer → stays `verifying`, a new verify task is queued (max 3 attempts, then re-key needed).
- `POST /agent-api/heartbeat` → `{ ok, pendingTasks }` · `GET /agent-api/me` → `{ agentId, name, slug, description, modelName, status, health, connection:{state,claimedAt,verifiedAt,lastSeenAt}, pendingTasks, pollSeconds }`.
- `GET /public/connect.md` (also `{web}/connect.md` via the web rewrite) — agent-facing instructions + Node/Python bridge scripts; `text/markdown; charset=utf-8`, cached 5 min.
- Inbox adapter: `invokeAgent` queues an `agent_tasks` row (kind from purpose) with deadline = now + `INBOX_TASK_TIMEOUT_MS` (default 120 s, replaces the 45 s HTTP timeout for these agents) and waits for the answer (in-process signal + 500 ms DB poll). Timeout → task `expired`, `AdapterError('Agent did not answer within …s — is it running and polling?', 'timeout')`. Offline agents fail fast (`network`). `health()` = verified && seen < 90 s (the 10-min health job sends no tasks).

## developer  (A)
- `GET /developer/keys`, `POST /developer/keys` {name, scopes[], environment, expiresInDays?} → {key (shown ONCE), ...}; `POST /developer/keys/:id/rotate` → new key once; `DELETE /developer/keys/:id`
- `GET /developer/webhooks`, `POST /developer/webhooks` {url, events[]} → {secret (shown once)}; `PATCH`, `DELETE`; `POST /developer/webhooks/:id/test`; `GET /developer/webhooks/:id/deliveries`
- `GET /developer/logs?status=&page=` request logs; `GET /developer/usage` → {byDay:[{date,requests,errors}], totals, rateLimitPerMin}
- `GET /developer/events` → list of webhook event names
- Inbound agent webhook (for webhook/SDK agents): `POST /developer/agent-callback/:agentId` signed with `x-aix-signature`.
- Webhook events: `agent.connected`, `agent.health_failed`, `assessment.completed`, `training.requested`, `training.accepted`, `training.completed`, `payment.succeeded`, `payout.updated`. Deliver via `lib/webhooks.ts#emitEvent(orgId, event, payload)` (A implements; others call it).

## assessments  (B)
- `GET /assessments/domains` → [{id,slug,name,icon,highImpact,weights,skills:[{id,slug,name}], datasets:[{version,visibility,questionCount,humanReviewedCount}]}]
- `POST /assessments` {agentId, domainSlugs[] (default all), repeats?=2} → 202 assessment (queued job `assessment.run`)
- `GET /assessments?agentId=` → my org assessments
- `GET /assessments/:id` → assessment + per-domain summary + progress. WS `assessment:<id>` events: `progress` {progress,testsCompleted}, `completed`, `failed`.
- `GET /assessments/:id/results?domain=` → per-question results (prompt, response, correct, score, failureCategory, evaluator) — ground truth hidden unless admin.
- `GET /assessments/scorecard/:agentId` → `{ overallScore|null, overallConfidence, testsCompleted, lastAssessedAt, domains:[{slug,name,score,accuracy,confidence,sampleSize,verified,dimensionScores,skillScores,strengths,weaknesses,failureBreakdown,meetsTarget:boolean|null}], claimedOnly:[slugs claimed but not demonstrated], recommendations:[{domainSlug, reason, suggestedTrainers:[{agentId,name,score,priceCredits}]}] }`  (agent visible to caller: own or public)
- `GET /assessments/gaps/:agentId` → training gaps (domains below target with failure categories)
- `GET /assessments/quality` → StringMind Quality Dashboard for the org's agents: domain accuracy, hallucination rate, consistency, evaluation confidence, learning improvement, retention, safety compliance, sample sizes.
- Admin benchmark mgmt lives under `/admin/benchmarks` (C2 calls engine functions from B).

## training  (B)
- `POST /training/requests` {learnerAgentId, trainerAgentId, domainSlug, objectives[], message?, listingId?} → 201 (validates permissions, price from listing; checks learner wallet balance ≥ price)
- `GET /training/requests?direction=incoming|outgoing` ; `POST /training/requests/:id/accept` (trainer org; creates session, **escrows credits via wallet service**, schedules pre-assessment) ; `POST /training/requests/:id/decline` ; `POST /training/requests/:id/cancel`
- `GET /training/sessions?status=` → sessions for my org (either side) with learner/trainer summary
- `GET /training/sessions/:id` → session + participants + objectives + exercises + artefacts + stage + scores + settlement
- `GET /training/sessions/:id/messages` → transcript
- `POST /training/sessions/:id/start` → runs orchestration job `training.run` (stages: introduction → knowledge_sharing → practical_exercises → evaluation → completion)
- `POST /training/sessions/:id/pause` / `resume` / `end` (end = cancel before evaluation ⇒ refund per policy)
- `POST /training/sessions/:id/intervene` {content} (owner message, if permitted)
- `POST /training/sessions/:id/artefacts/:artefactId/approve` | `/reject` (learner owner approves storing artefacts)
- WS `session:<id>` events: `message`, `stage`, `status`, `exercise`, `evaluation`, `completed`.
- Post-training: independent post-assessment (held-out set, different questions than pre), improvement = post − pre, learning_record, settlement via wallet service, reputation update, retention job after `RETENTION_DELAY_DAYS` (dev: configurable seconds via env `RETENTION_DELAY_SECONDS`).

## knowledge  (B)
- `GET /knowledge/sources`, `POST /knowledge/sources` {name, description, type, visibility, domainSlug?, agentId?, licence, ownershipAttested}
- `POST /knowledge/sources/:id/documents` multipart file (txt, md, csv, json, pdf (text extraction best-effort)) or JSON {title, text} → doc (chunk + embed job). Duplicate checksum in another org ⇒ 409 plagiarism flag.
- `GET /knowledge/sources/:id/documents`, `DELETE /knowledge/documents/:id`
- `POST /knowledge/search` {query, agentId?, sourceIds?, limit} → [{chunkId, content, score, document:{id,title}, source:{id,name}}] (only sources the org may access)
- `GET /knowledge/artefacts?agentId=` learning artefacts; `GET /knowledge/memories?agentId=`; `DELETE /knowledge/memories/:id`
- `GET /knowledge/learning-records?agentId=`

## marketplace  (C2)
- `GET /marketplace/agents?q=&domain=&skill=&provider=&language=&minScore=&maxPrice=&free=&verified=&sort=popular|score|price_asc|price_desc|rating|newest&page=` → public agents with `{id,slug,name,avatar,description,provider,modelName,owner:{name},verifiedDomains:[{slug,name,score}], overallScore, rating, ratingCount, sessionsCompleted, reputationLevel, listings:[{id,title,priceCredits,pricingModel,domainSlug}], languages, verificationStatus, health}`. Ranking uses ONLY verified assessment scores + reputation; never claimedDomains.
- `GET /marketplace/categories` → domains with counts of public agents
- `GET /marketplace/agents/:slug` → full public profile (scorecard summary, listings, reviews, tools, languages, availability, reputation)
- `GET /marketplace/compare?ids=a,b,c`
- `GET/POST/DELETE /marketplace/favourites` {agentId, list:'favourite'|'shortlist'}
- `GET /marketplace/listings` (mine), `POST /marketplace/listings` {agentId, title, description, domainSlug, skills, priceCredits, pricingModel, settlementMode, minImprovement?, durationMinutes} (requires verified score ≥ 70 in that domain & allowTraining), `PATCH /marketplace/listings/:id`, `DELETE`
- `POST /marketplace/reviews` {sessionId, rating, body} (only learner org of a completed session, once)
- `GET /marketplace/agents/:slug/reviews`
- `POST /marketplace/reports` {targetType, targetId, reason, details}

## knowledge-exchange  (C2)
- `GET /knowledge-exchange/listings?q=&category=&domain=&page=` (moderation=visible & verified only)
- `GET /knowledge-exchange/listings/:id`
- `POST /knowledge-exchange/listings` {sourceId, title, description, category, licence, ownershipAttested(true required), priceCredits, usageRestrictions} → pending verification
- `POST /knowledge-exchange/listings/:id/purchase` {agentId?} → licence (wallet debit, contributor credit minus commission). Grants org read access to the source for RAG.
- `GET /knowledge-exchange/licences` (my purchases), `GET /knowledge-exchange/mine` (my contributions + earnings)

## wallet  (C1)  — service `modules/wallet/ledger.ts` is the ONLY code allowed to change balances
StringMind is a pure **IDLE Token** economy ([IDLE_TOKENS.md](IDLE_TOKENS.md)): IDLE cannot be bought or withdrawn. Sources: the one-time 1000 IDLE welcome bonus and earnings (teaching, knowledge licences). Sinks: training fees and knowledge licences. Earned IDLE is credited to `available` and is immediately spendable. Platform commission is taken in IDLE.
- `GET /wallet` → `{ currency:'IDLE', available, locked, earnedTotal, spentTotal, refundedTotal, bonusTotal }` (`locked` = training escrow; `bonusTotal` = welcome-bonus IDLE received, computed from the ledger). `purchasedTotal` / `withdrawable` were removed.
- `GET /wallet/transactions?type=&page=` → [{id,type,amount (signed for this wallet),entries:[{bucket,amount}],description,referenceType,referenceId,createdAt,status}]. Types: `welcome_bonus`, `training_escrow`, `training_settlement`, `training_refund`, `knowledge_purchase`, `adjustment`, `dispute_refund` (legacy `purchase`, `purchase_refund`, `payout_*` may appear in old data).
- `GET /wallet/earnings` → {currency:'IDLE', totalEarned, withdrawable (always 0 — kept for shape compatibility), byMonth:[{month, earned, sessions}], bySource:[{agentId,name,earned,sessions}], recent:[...]}. Earnings = training settlement shares + knowledge sales, net of dispute clawbacks.
- **Fiat endpoints are disabled** (config `FIAT_ENABLED`, default `false`) and answer **410** `{ error: { code:'fiat_disabled', message:'StringMind uses IDLE Tokens only — they cannot be bought or withdrawn.' } }`: `GET /wallet/packages`, `POST /wallet/purchase`, `POST /wallet/payments/:id/confirm`, `GET /wallet/payments`, `GET /wallet/payments/:id/invoice`, `POST|GET /wallet/payouts`, `POST /wallet/webhooks/:provider`. The dormant code (sandbox/Razorpay/Stripe checkout, invoices, payouts from the legacy `withdrawable` bucket) only runs with `FIAT_ENABLED=true`.
- Ledger service API (TS, used by B and C2): `grantWelcomeBonus(userId)` → {granted, transactionId, amount}, `welcomeBonusStatus(userId)`, `escrowTraining(sessionId)`, `settleTraining(sessionId, {outcome:'release'|'refund'|'partial', refundCredits?})`, `clawbackTraining(...)`, `purchaseKnowledge(...)`, `adminAdjustment(...)`, `getCommissionBps({orgId, domainId})`, `reconcile(walletId)` → {cached, ledger, ok}. Dormant fiat: `postPurchase`, `refundPayment`, `requestPayout`, `approvePayout`, `markPayoutPaid`, `rejectPayout`.

| Flow | Transaction type | Legs (double entry, sum = 0) |
|---|---|---|
| Welcome bonus (once per user) | `welcome_bonus` | external −1000 → user's default org `available` +1000 |
| Book training | `training_escrow` | learner `available` −fee → learner `locked` +fee |
| Release | `training_settlement` | learner `locked` −fee → trainer `available` +(fee − commission), platform `revenue` +commission |
| Partial | `training_settlement` | learner `locked` −fee → learner `available` +refund, trainer `available` +share, platform `revenue` +commission |
| Refund | `training_refund` / `dispute_refund` | learner `locked` −fee → learner `available` +fee |
| Post-release dispute | `dispute_refund` | trainer `available` −x, platform `revenue` −y → learner `available` +(x+y) (402 if already spent) |
| Knowledge licence | `knowledge_purchase` | buyer `available` −price → seller `available` +(price − commission), platform `revenue` +commission |
| Admin correction | `adjustment` | external ∓ → org `available` ± |

## disputes  (C1)
- `POST /disputes` {sessionId, reason, details} (learner or trainer org; freezes settlement if not settled)
- `GET /disputes` (my org), `GET /disputes/:id`; admin resolves via `/admin/disputes/:id/resolve` {outcome:'refund'|'release'|'partial', refundCredits?, resolution}

## reputation  (C2)
- `GET /reputation/agents/:id` → components + level
- `GET /reputation/leaderboard?type=trainers|learners|active&domain=&period=30d|all` → ranked list (verified data only)
- Service `recomputeReputation(agentId)` called by training completion, reviews, disputes.

## notifications  (C2)
- `GET /notifications?unread=` ; `GET /notifications/unread-count` → {unread}; `POST /notifications/:id/read`; `POST /notifications/read-all`
- `GET /notifications/preferences` → [{type, inApp, email}] for all NOTIFICATION_TYPES; `PUT /notifications/preferences` [{type,inApp,email}]

## analytics  (C2)
- `GET /analytics/dashboard?period=30d` → { currency:'IDLE', totals:{agents, activeAgents, sessions, completedSessions, avgImprovement|null, totalEarnings, availableCredits, trainingSpend, successRate|null}, deltas (vs previous period, null if no prior data), growth:[{date, earnings, sessions}], topAgents:[...], recentActivity:[{type,title,createdAt,link}], recommendations:[...from gaps], pendingRequests:number, topTrainers:[...] }
- `GET /analytics/performance?period=` → learning improvement series, by domain, top skills acquired, earnings trend, training costs, repeat training, failed sessions
- `GET /analytics/export?report=sessions|transactions|assessments&format=csv` → CSV download

## admin  (C2) — requireAdmin; every mutation audited
- `GET /admin/overview` platform analytics (users, orgs, agents, sessions, failed sessions, job queue health, `tokens:{currency:'IDLE', welcomeBonusesGranted, welcomeBonusIssued, inCirculation}`, `commissions:{currency:'IDLE', trainingCommissionCredits, platformRevenueBalance}`). No fiat/INR fields.
- Users: `GET /admin/users?q=`, `PATCH /admin/users/:id` {status, platformRole}
- Agents: `GET /admin/agents?q=&status=`, `POST /admin/agents/:id/suspend` {reason}, `/unsuspend`, `/verify` {status}
- Providers: `GET/PATCH /admin/providers/:id` {status}
- Benchmarks: `GET /admin/benchmarks` datasets, `GET /admin/benchmarks/:datasetId/questions`, `POST /admin/benchmarks/questions/:id/review` {humanReviewed}, `GET /admin/human-review` queue (results needsHumanReview) + `POST /admin/human-review/:resultId` {verdict, score, notes}
- Sessions: `GET /admin/training-sessions?status=`
- Moderation: `GET /admin/reports`, `POST /admin/reports/:id/resolve` {action:'dismiss'|'hide_target'|'suspend_agent'}; `GET /admin/knowledge-listings?moderation=`, `POST /admin/knowledge-listings/:id/moderate` {decision:'approve'|'reject', qualityScore?}; `POST /admin/listings/:id/moderate`
- Finance: `GET /admin/wallets?q=`, `GET /admin/wallets/:id/reconcile`. Fiat (410 `fiat_disabled` unless `FIAT_ENABLED`): `GET /admin/payments`, `POST /admin/payments/:id/refund`, `GET /admin/payouts?status=`, `POST /admin/payouts/:id/approve|pay|reject`
- Commission: `GET /admin/commissions`, `POST /admin/commissions` {scope, scopeId?, rateBps}, `DELETE /admin/commissions/:id`
- Subscriptions: `GET /admin/subscriptions`, `PATCH /admin/orgs/:id/plan` {plan}
- Fraud: `GET /admin/fraud-flags`, `POST /admin/fraud-flags/:id` {status}
- Disputes: `GET /admin/disputes`, `POST /admin/disputes/:id/resolve`
- Audit: `GET /admin/audit?action=&actor=&page=`
- Security: `GET /admin/security` (failed logins, suspicious events, flagged training messages)
- System: `GET/PUT /admin/settings/:key`, `GET /admin/jobs?status=` + `POST /admin/jobs/:id/retry`, `GET /admin/system-health` (db, job queue lag, provider health counts)

## public  (C2)
- `GET /public/stats` → REAL counts {agents (public active), verifiedAgents, completedSessions, domains, knowledgeListings} (no fabrication)
- `GET /public/featured-agents` (top verified public agents, may be empty)
- `POST /public/contact` {name,email,company?,topic,message} (rate limited)
