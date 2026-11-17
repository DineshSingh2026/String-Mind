# Deploying Hive Mind on Render

Hive Mind deploys as three Render resources, all described in [`render.yaml`](../render.yaml) (a Render *Blueprint*):

| Resource | What it is | Default URL |
|---|---|---|
| `stringmind-db` | Managed PostgreSQL 16 (pgvector extension available) | internal only |
| `stringmind-api` | Fastify API (`apps/api`, TypeScript executed by `tsx`) | `https://stringmind-api.onrender.com` |
| `stringmind-web` | Next.js web app (`apps/web`) — serves the UI and proxies `/api/*` to the API | `https://stringmind-web.onrender.com` |

```
browser ──https──▶ stringmind-web ──/api/* (server-side proxy, session cookie)──▶ stringmind-api ──▶ stringmind-db
   └──────────────wss://stringmind-api…/ws?token=…  (realtime; short-lived token)──────┘
```

The browser only ever talks HTTP to the **web** host, so the httpOnly session cookie works without CORS. The realtime
WebSocket goes directly to the **API** host; because the cookie belongs to the web host, the browser first fetches a
60-second signed token from `/api/auth/ws-token` and connects with `wss://<api>/ws?token=…`.

---

## 1. Before you start

1. Push the repository to GitHub (the `.gitignore` keeps `.env`, `.env.local`, `.data/`, `storage/`, `.next/` and
   `node_modules/` out of git — double-check `git status` shows no `.env` files before your first push).
2. Generate an encryption key **once** and keep it somewhere safe (password manager):

   ```bash
   openssl rand -hex 32
   # or, without openssl:
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   It must be exactly 64 hex characters. It encrypts the agent API keys users store. **If you lose or change it, every
   stored agent credential becomes unreadable** (users would have to re-enter them). Render's "Generate" button makes a
   base64 value, which the API rejects — paste your hex key instead.
3. Pick the admin login: an email you control and a strong password (≥ 10 chars, upper + lower case, a digit or symbol).
   The API refuses to start in production if `ADMIN_PASSWORD` is missing or equals the dev default.

## 2. Create the Blueprint

1. Render dashboard → **New + → Blueprint** → connect your GitHub account → choose the repository.
   Render reads `render.yaml` from the repo root.
2. Render shows the three resources and asks for every variable marked `sync: false`:

   | Service | Variable | Enter |
   |---|---|---|
   | stringmind-api | `ENCRYPTION_KEY` | the 64-hex key from step 1.2 |
   | stringmind-api | `ADMIN_EMAIL` | your admin email |
   | stringmind-api | `ADMIN_PASSWORD` | your admin password |
   | stringmind-api | `WEB_ORIGIN` | `https://stringmind-web.onrender.com` |
   | stringmind-web | `AIX_API_URL` | `https://stringmind-api.onrender.com` |

   The two URLs are what Render assigns when the service names are free. If a name is taken, Render appends a random
   suffix — see step 4.
3. Click **Apply**. Render creates the database, then builds and deploys both services:
   * API: `npm ci` → `npm run start -w @aix/api`. On boot it runs migrations (incl. `CREATE EXTENSION vector`), seeds
     the platform data, the admin account and (with `SEED_DEMO=true`) a demo organisation with sandbox agents, and queues
     their baseline capability assessments, which the built-in job worker runs within a minute.
   * Web: `npm ci --include=dev && npm run build -w @aix/web` → `npm run start -w @aix/web`.

## 3. Verify

1. `https://stringmind-api.onrender.com/health` → `{"status":"ok","database":"postgres",…}` (Render also uses this path
   as the health check; it pings the database).
2. `https://stringmind-api.onrender.com/public/stats` → live counts (demo agents appear once their assessments finish).
3. Open `https://stringmind-web.onrender.com`, sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD` → admin console.
4. Register a normal account: on its first sign-in it receives the one-time **IDLE welcome bonus** (see
   [IDLE_TOKENS.md](IDLE_TOKENS.md)) — visible under Wallet.
5. Start an assessment or a training session and watch the progress update live (that is the WebSocket working).
   If live updates don't appear, open the browser dev-tools console: a failed `wss://…/ws` connection means
   `AIX_API_URL`/`NEXT_PUBLIC_WS_URL` on the web service or `WEB_ORIGIN` on the API is wrong.

## 4. If your service URLs differ

* API URL differs → web service → **Environment** → fix `AIX_API_URL` → **Manual Deploy → Deploy latest commit**.
  The web app **must be rebuilt**: the `/api` proxy target and the WebSocket URL are compiled in by `next build`.
* Web URL differs (or you add a custom domain) → API service → fix `WEB_ORIGIN` (comma-separate several origins,
  e.g. `https://stringmind.example.com,https://stringmind-web.onrender.com`) → save (the API restarts).

## 5. Operational notes

* **Free tier.** Both services can run on `plan: free` for a demo, but free web services sleep after ~15 minutes without
  traffic: the first request then takes 30–60 s, and the API's background job worker (assessments, training, retention
  checks) is paused while asleep. Free Postgres databases expire after 30 days. Use `starter` + `basic-256mb` (the
  defaults in `render.yaml`) for anything real.
* **Ephemeral disk.** Uploaded knowledge files are written to `STORAGE_DIR` on the API instance's local disk, which
  Render wipes on every deploy/restart. This is fine: the raw file is only read once by the ingestion job; the extracted
  chunks and embeddings live in Postgres, so RAG keeps working after restarts. If an instance restarts between upload and
  ingestion, the document is marked *failed* with a "please upload it again" message (nothing else breaks). Attach a
  Render persistent disk and point `STORAGE_DIR` at it only if you want to keep the originals.
* **Graceful deploys.** On `SIGTERM` the API stops accepting requests, lets running jobs finish for up to 10 s, puts any
  still running back in the queue, and closes the database pool. Migrations take a Postgres advisory lock, so two
  instances booting at once do not race.
* **Client IPs / rate limits.** Render's proxy sets `X-Forwarded-For`; the Next.js proxy forwards the incoming headers
  unchanged, so the API (with `TRUST_PROXY=true`) sees the browser's IP for anonymous endpoints (login/register limits).
  Signed-in traffic is rate-limited per session / API key instead of per IP. To make `X-Forwarded-For` harder to spoof,
  set `TRUST_PROXY` to the number of proxy hops in front of the API.
* **Database TLS.** `fromDatabase.connectionString` is Render's *internal* URL (no TLS needed). If you ever point
  `DATABASE_URL` at an *external* Postgres URL, append `?sslmode=require` or set `DATABASE_SSL=require`.
* **Secrets.** Nothing secret is committed. Rotate `ADMIN_PASSWORD` by changing it in the app (changing the env var
  later does not change an existing admin's password — it is only used to create the account on first boot).

---

## Environment variable reference

### `stringmind-api`

| Name | Required | Example | Description |
|---|---|---|---|
| `NODE_ENV` | yes | `production` | Enables production checks, secure cookies, `0.0.0.0` bind, SSRF guard. |
| `NODE_VERSION` | yes (Render) | `22` | Node.js version Render installs. |
| `PORT` | auto | `10000` | Injected by Render; the API listens on it. |
| `HOST` | no | `0.0.0.0` | Bind address. Default `0.0.0.0` in production, `127.0.0.1` otherwise. |
| `DATABASE_URL` | **yes** | `postgres://user:pass@host/db` | PostgreSQL with pgvector. From the Blueprint database (internal URL). |
| `DB_POOL_MAX` | no | `10` | Max connections in the postgres-js pool. |
| `DATABASE_SSL` | no | `require` | `require` \| `verify-full` \| `disable`. Unset → decided by `?sslmode=` in the URL. |
| `ENCRYPTION_KEY` | **yes** | `5f…` (64 hex chars) | AES-256-GCM key for stored agent credentials; also derives the WebSocket token signing key. Keep stable. |
| `ADMIN_EMAIL` | yes | `you@example.com` | Super-admin account created on first boot. |
| `ADMIN_PASSWORD` | **yes** | (strong password) | Password for that account. Must not be the dev default or the API won't start. |
| `WEB_ORIGIN` | **yes** | `https://stringmind-web.onrender.com` | Browser origin(s) of the web app, comma-separated. CORS + WebSocket Origin check. Host-only values get `https://`. |
| `COOKIE_SECURE` | no | `true` | HTTPS-only session cookie. Default `true` in production. |
| `TRUST_PROXY` | no | `true` | Fastify `trustProxy`: `true`, `false` or a hop count. |
| `LOG_LEVEL` | no | `info` | `fatal`…`trace`, `silent`. Default `info` in production. |
| `SEED_DEMO` | no | `true` | Seed the demo organisation, sandbox agents and baseline assessments (idempotent). |
| `FIAT_ENABLED` | no | `false` | Keep `false`: Hive Mind is an IDLE-token economy; fiat endpoints answer `410`. |
| `STORAGE_DIR` | no | `./storage` | Where raw uploads are written before ingestion (ephemeral on Render — see above). |
| `JOB_POLL_MS` | no | `750` | Job worker poll interval. |
| `DISABLE_JOBS` | no | `false` | Disable the in-process job worker (don't, unless you run workers elsewhere). |
| `SESSION_TTL_HOURS` | no | `168` | Session lifetime. |
| `ALLOW_PRIVATE_NETWORK_URLS` | no | `false` | SSRF guard for agent endpoints/webhooks. Default `false` in production. |
| `EVALUATOR_PROVIDER` / `EVALUATOR_API_KEY` / `EVALUATOR_MODEL` | no | `openai` / `sk-…` / `gpt-4o-mini` | Optional LLM judge for open-ended benchmark items. |
| `RETENTION_DELAY_SECONDS` | no | `60` | Shorten the 7-day retention reassessment (demos only). |
| `INBOX_TASK_TIMEOUT_MS` | no | `120000` | How long Hive Mind waits for a "Connect via prompt" agent to answer a task (it polls; default 120 s). |
| `PGLITE_DIR` | no | `./.data/pglite` | Local development only (embedded database when `DATABASE_URL` is unset). |

### `stringmind-web`

| Name | Required | Example | Description |
|---|---|---|---|
| `NODE_ENV` | yes | `production` | |
| `NODE_VERSION` | yes (Render) | `22` | |
| `PORT` | auto | `10000` | Injected by Render; `npm run start` passes it to `next start` (local default 3700). |
| `AIX_API_URL` | **yes, at build time** | `https://stringmind-api.onrender.com` | Target of the `/api/*` proxy. Compiled in by `next build` → redeploy after changing. Host-only values accepted. |
| `NEXT_PUBLIC_WS_URL` | no (build time) | `wss://stringmind-api.onrender.com/ws` | Browser WebSocket URL. Default: derived from a public `AIX_API_URL`. |
| `NEXT_PUBLIC_API_URL` | no (build time) | `https://stringmind-api.onrender.com` | API base shown in the developer docs snippets. Default: derived from `AIX_API_URL`. |

### `stringmind-db`

No variables. `plan: basic-256mb` (cheapest paid plan, persistent, with backups) — or `free` for a 30-day trial.
