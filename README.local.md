# README (local) — Clio Remote MCP Connector

Fork-local notes for our deployment of `oktopeak/clio-mcp`. Upstream's own `README.md`
stays as-is; everything specific to *our* remote/multi-user build lives here and in
`docs/build-notes.md` + `CHANGELOG.local.md`.

---

## Status — M4 deployed (21 Clio tools ported, multi-tenant; no hosted logs; awaiting real Clio app)

- **Live:** `https://clio-oauth-mcp.beatech.workers.dev` — full two-leg OAuth + the ported tools. Leg 1
  (Claude ⇄ us) is the `@cloudflare/workers-oauth-provider` AS + RS; Leg 2 (us ⇄ Clio) is the Clio broker:
  `/authorize` redirects to Clio, `/clio/callback` exchanges the code, reads `who_am_i`,
  **AES-256-GCM-encrypts** the per-user tokens into D1, and mints the Leg-1 token bound to the real Clio
  user. **M4:** `/mcp` now serves 23 tools — `clio_ping`, `clio_whoami`, and 21 `clio_`-prefixed Clio data
  tools, each acting as the authenticated caller's own Clio account via the upstream AsyncLocalStorage seam
  (the 22nd, `upload_document`, is stdio-only — it reads a local file path a Worker can't reach). `/mcp` is
  bearer-gated.
- **No hosted logs (operator decision):** the pilot persists no audit/connection log. M5 (a D1 `audit_log`)
  was built then removed; `observability` is `false` (no Workers request logs; `wrangler tail` still works).
  The D1 holds only the per-user OAuth token store.
- **Repo:** `b0dea/clio-oauth-mcp` (fork of `oktopeak/clio-mcp`; `upstream` remote set for merges).
- **Provisioned** (CF `Alex@beatech.dev`, EU): D1 `clio-oauth-mcp` (schema applied: `users`, `clio_tokens`,
  `pending_auth`) + KV `OAUTH_KV` + KV `CLIO_TOKENS`. Secrets set: `ENCRYPTION_KEY`;
  `CLIO_CLIENT_ID`/`SECRET` are **placeholders** until a real Clio private app exists.
- **Blocked on (operator):** register a **Clio private app** against the firm's Clio account with redirect URI
  `https://clio-oauth-mcp.beatech.workers.dev/clio/callback`, then `wrangler secret put CLIO_CLIENT_ID` +
  `CLIO_CLIENT_SECRET`. That unblocks live per-user tool calls + two-user acceptance (a Leg-1 token can't be
  minted until Leg-2 completes, so authenticated `/mcp` calls stay gated until then).
- **Engineer, start here:** `src/remote/README.md` — milestone map. **M4 done** (tools ported, multi-tenant;
  audit logging intentionally not hosted); next is **M6** (hardening + automated cross-user isolation test +
  two-user acceptance).
- **Commands:** `npm install` · `npm run build` (stdio baseline) · `npm run typecheck:worker` · `npm run deploy`.
- **Secrets** (not set yet): `ENCRYPTION_KEY`, `CLIO_CLIENT_ID`, `CLIO_CLIENT_SECRET`, `COOKIE_ENCRYPTION_KEY` via `wrangler secret put`.
- **Moving to a new org / CF account later:** `docs/migration.md`.

---

## Deployment model (decided)

**Single-firm, private Clio app, per-user OAuth — not a public connector.**

A law firm is one Clio account with many users. We register **one private Clio app** against
that firm's Clio account (no public App Directory listing, no Clio security review), deploy
**one Worker**, and add it to Claude Desktop as a custom connector. Each attorney clicks
**Connect** and logs into **their own** Clio — that's the entire user-facing step.

What each non-technical user does to connect:
1. Open the connector in Claude Desktop and click **Connect**.
2. Get redirected to Clio, log in with their normal Clio credentials, approve.
3. Done — Claude now acts on their own Clio data, isolated from everyone else's.

No API keys, no per-user app registration, no config. (Clio is OAuth-only; there is no
user-facing API-key path, so OAuth-per-user is both the lowest-friction and the only sane option.)

One-time technical setup (done once by whoever deploys — see `docs/operations.md` when written):
register the private Clio app, deploy the Worker, set secrets, add the connector URL to the org.

---

## §0 values (resolved)

| Key | Value | Notes |
|---|---|---|
| `GITHUB_FORK_ORG` | **`b0dea`** (personal, for now) | Owns the fork. Lives **only in git remotes** — never referenced in code, so moving to a new org is a one-line `git remote set-url origin …`. |
| `CLOUDFLARE_ACCOUNT` | **`Alex@beatech.dev's Account`** · id `3699b6ddabe8729341468d6ebfe8a4ea` | Personal CF account (from `wrangler whoami`). Set as `account_id` in `wrangler.jsonc` only. |
| `WORKER_HOSTNAME` | **`*.workers.dev`** (staging) | Custom domain TBD; swap by editing `routes`/`name` in `wrangler.jsonc`, no source change. |
| `CLIO_REGION` | **`EU`** → `eu.app.clio.com` | UK firm → Clio EMEA/EU region (confirmed). Worker var; drives all Clio base + OAuth URLs. OAuth on the same host: `eu.app.clio.com/oauth/*` (not `auth.api.clio.com`). |
| `V1_WRITE_SCOPE` | **`all`** | Register **everything the fork exposes** (all 26 tools incl. the 9 writes). Clio app permissions = read/write. Per-tool allow/deny is left to each user inside Claude Desktop. Safe because every user only ever acts on **their own** Clio with their own Clio-side permissions. |

`CLIO_REGION` host map: US `app.clio.com` · EU `eu.app.clio.com` · CA `ca.app.clio.com` ·
AU `au.app.clio.com` (all `/api/v4`).

## Portability — moving git org / CF account / domain later

Built so a future move costs no source edits:
- **Git org** → only in `origin`/`upstream` remotes; `git remote set-url` and push.
- **CF account / Worker name / custom domain** → `account_id`, `name`, `routes` in `wrangler.jsonc`; redeploy.
- **Region** → the `CLIO_REGION` var (drives every Clio URL via the region config); no hardcoded hosts.
- **Clio app** → `CLIO_CLIENT_ID`/`CLIO_CLIENT_SECRET` via `wrangler secret put`; never in the repo.

Nothing project-specific (org, account, hostname, region, client IDs) is baked into TypeScript — it's all config/secrets.

---

## Corrections vs. the original PRD (verified against upstream source + live Clio docs, 2026-06-11)

- **Write surface is 9 tools, not 2.** `create_matter`, `upload_document`, `create_task`,
  `update_task`, `complete_task`, `create_calendar_entry`, `log_time_entry`, `create_activity`,
  `create_note`. Affects the threat model and what `read-only` must gate.
- **26 tools across 9 resource areas**, not 7.
- **"ABA-Opinion-512" is marketing**, not a code feature — the audit log is generic JSONL.
- **AES-256-GCM helper is rewritten, not ported** (Node `crypto` → Workers SubtleCrypto).
- **No Clio public-app review needed** for the single-firm model (the blocker only applies to
  cross-firm public connectors).

Full detail in `docs/build-notes.md`.

---

## Open items

**Confirmed by the 2026-06-11 audit:** private-app multi-user OAuth within one firm; UK = Clio EU
region (`eu.app.clio.com`); OAuth on the same regional host (not `auth.api.clio.com`); refresh tokens
non-rotating + non-expiring. None of these block the design.

**Resolved at M1:** `@hono/mcp` `StreamableHTTPTransport` runs stateless on Workers; SDK #1944
(JSON-only `Accept` 406) avoided via its default `strictAcceptHeader:false` — verified live (see
`CHANGELOG.local.md` / `docs/build-notes.md` §10).

**Resolved at M2 (2026-06-11):** the Hono `/mcp` app wires into `OAuthProvider.apiHandler` as the
plain `{ fetch: api.fetch.bind(api) }` object form, and `ctx.props` is delivered through it as
`c.executionCtx.props` (no `WorkerEntrypoint` needed) — see `docs/build-notes.md` §10 + `CHANGELOG.local.md`.

**Still to settle at build time (engineering spikes, not blockers):**
1. Exact `fields` nesting depth (one vs two levels) against the live Clio docs (M4).
