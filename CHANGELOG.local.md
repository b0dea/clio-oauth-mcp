# CHANGELOG (local) — deltas vs. upstream `oktopeak/clio-mcp`

Running log of every change we make on top of upstream, so `git merge upstream/main` stays
reasoned-about. Record the upstream commit SHA after each sync and tag `upstream-sync/<date>`.

Format: newest first. Note **why**, and whether a change edits an upstream file (conflict risk)
or adds a new module (merge-safe).

---

## 2026-06-11 — M7: evals + docs completeness + upstream-sync dry run (clean no-op)

Final milestone (PRD §M7 / §9 / §8). All changes are **merge-safe** — a new `evals/` file, `docs/`
additions, and a one-line log-format fix in our own `src/remote/mcp/api.ts`. **No upstream tool files
edited.**

- **10 read-only eval questions** — new `evals/clio-evals.xml` (PRD §9 XML format). Each is read-only,
  independent (runs in any order, no shared state), requires multiple `clio_` tool calls, is realistic
  for a firm, and resolves to one string-verifiable answer (a count, sum, name, or phone number).
  Delivered as a **template**: answers are firm-specific, so each carries `FIRM-SPECIFIC — operator
  fills …` and every `&lt;placeholder&gt;` is filled against a known record. Tool names verified against
  `adapter/clioTools.ts` — only read tools appear, all `clio_`-prefixed; no write tool and not
  `upload_document` (not ported). Schema extends §9 with two non-normative children, `<tools>` (the
  exact tools each answer uses) and `<method>` (the call sequence), so the operator can reproduce.
- **Docs completeness** (`docs/operations.md`) — added the one genuine gap, **Add / remove the
  connector (Claude org)**: the org Owner adds the `/mcp` URL once (Organization settings → Connectors),
  each user Connects their own Clio, opt-out per-tool toggles are called out, and full off-boarding
  (remove connector → purge the user's `clio_tokens`/`users` rows + the `clio-token:` KV cache → revoke
  the app in Clio). Confirmed the rest was already covered: deploy, secrets/key-rotation, Clio-app
  registration, rate limiting, audit (off by default, with the read-only D1 export query), the
  upstream-sync runbook, and the PRD §7 data-flow note. Status banner bumped M6 → M7.
- **Upstream-sync dry run (PRD §8) — clean no-op.** `git fetch upstream`; `git log main..upstream/main`
  is **empty** — `oktopeak/clio-mcp` has shipped nothing since the fork (upstream HEAD is still
  `d85f3be`, identical to our merge-base; last release v2.0.0). No merge performed, no conflicts to
  resolve. Tagged `upstream-sync/2026-06-11`. The three rewritten files
  (`tokenStorage.ts`/`auditLog.ts`/`oauth.ts`, build-notes §7) stay the conflict-risk set for whenever
  upstream next moves; the runbook in `docs/operations.md` covers that path.
- **`mcp/api.ts` catch-all consistency (operator-approved).** The pre-existing `onError` handler now
  logs `err instanceof Error ? err.message : String(err)`, matching every other `console.error` site in
  `src/remote/` (was the raw `err` object — flagged in the M6 review). Nil security delta; removes the
  one outlier. Not an upstream file.

**Quality gates:** `/simplify` (no-op — the M7 change set is docs/XML + one log line, nothing to
simplify) + a security-weighted feature-dev review (focus: evals truly read-only/independent/verifiable,
docs accuracy, and that the no-op sync weakened no M6 invariant — it touched no auth/token code). All
clear; no findings requiring code changes.

**Verified:** `npm run build` (stdio green) · `npm run typecheck:worker` green · `npx vitest run`
**168 green** (no test changes — M7 is docs/evals + a log-format line, no behavior change). No deploy
needed. Remote D1 still has **only** `users`/`clio_tokens`/`pending_auth` (migrations `0002`/`0003`
unapplied); `observability:false`.

**Pilot complete — remaining steps are operator-gated:** register the real Clio private app → confirm
`CLIO_CLIENT_ID`/`SECRET` are real → add the connector to the Claude org → run the live two-user
acceptance. The build, hardening, and isolation proof are done and green; only the live run waits on a
real Clio app. See `README.local.md`.

## 2026-06-11 — M6: hardening (redirect-URI pin + rate limiting) + automated cross-user isolation test

Hardening pass + the must-pass cross-user isolation proof (PRD §M6/§7). All changes are **merge-safe**
(new modules under `src/remote/` + `wrangler.jsonc`/`docs/` — **no upstream tool files edited**).

- **Cross-user isolation test (must-pass deliverable)** — new `src/remote/mcp/__tests__/isolation.test.ts`.
  Exercises the REAL injection seam end-to-end (two encrypted users in an in-memory `ClioTokenRepo` →
  `getValidClioToken` → AES-256-GCM decrypt → `buildClioSessionContext` → `sessionStorage.run` → the real
  `clio_list_matters` tool → `clioClient.resolveAccessToken` → outbound `Authorization` header), capturing the
  Bearer to prove each turn drives Clio with only the caller's own token. Covers: A→A's token, B→B's token;
  attacker-controlled tool args can't cross the `user_id` key; and `mcp/api.ts` fails loud (500) when the
  authenticated props are missing / carry no `userId` (identity is from the uninfluenceable token props, never
  caller input). Only the incidental fs-backed `appendAuditLog` is stubbed — not the token path under test.
- **Redirect-URI pinned to config (P1 from the M5 security pass)** — `auth/clio-handler.ts` `callbackRedirectUri`
  now derives from a new **`WORKER_BASE_URL`** var (`env.ts` + `wrangler.jsonc` vars) instead of the request
  host, byte-identical at `/authorize` and `/clio/callback`, failing loud if unset. A preview URL, custom
  domain, or spoofed `Host` can no longer change the `redirect_uri` Clio sees. Tested in new
  `auth/__tests__/clio-handler.test.ts` (pinned even when the request arrives on another host).
- **Per-IP rate limiting on the public OAuth endpoints** — new `src/remote/rateLimit.ts` +
  `AUTH_RATE_LIMITER` native Rate Limiting binding (`wrangler.jsonc` `ratelimits`, 60/60s). `worker.ts` now
  wraps `provider.fetch` (the only chokepoint that also covers the provider-owned `/token` + `/register`,
  which never reach our Hono handlers); `/authorize` + `/clio/callback` + `/token` + `/register` are limited
  per `CF-Connecting-IP` → `429` + `Retry-After`. `/mcp` excluded (bearer-gated; Clio rate-limits per token).
  Ephemeral edge counters — **no persistent activity log**. Fails OPEN if the binding is absent (defense-in-depth,
  not an authz gate — never brick login on a misconfig). Verified live: 60 pass / 40 → 429 from one IP.
- **Audience / PKCE / CSRF** — verified, no gaps. Added the audience-gate test (`/authorize` missing the
  RFC-8707 `resource` → 400) to `clio-handler.test.ts`; Leg-2 CSRF (single-use `DELETE…RETURNING` + expiry)
  already covered by `state.test.ts`; PKCE S256-only via `allowPlainPKCE:false`.
- **Key-rotation docs** (`docs/operations.md`) — `ENCRYPTION_KEY` rotation needs a read-all → decrypt-old →
  re-encrypt-new → write-back migration (else every decrypt fails and all users are disconnected); `CLIO_CLIENT_ID`
  forces re-Connect, `CLIO_CLIENT_SECRET` does not; `COOKIE_ENCRYPTION_KEY` safe anytime. Also documented the
  rate limiter + `WORKER_BASE_URL`, and refreshed the stale "skeleton" status banner.

**Quality gates:** `/simplify` (dropped a duplicate isolation case, trimmed comment repetition) + a
security-weighted feature-dev review — **all five M6 properties sound** (isolation seam genuine end-to-end,
redirect pinned, state single-use/expiring, PKCE+audience enforced, rate-limit path-matching correct for the
routing topology, no new persistent logging). One P1 raised on the **pre-existing** `mcp/api.ts:81` catch-all
(`console.error("api handler error:", err)` logs the raw error vs the `.message` guard used elsewhere) — **not
applied**: nil security delta (a token would live in `err.message`, logged either way; the stack carries no
tokens and aids debugging of genuine 500s) and out of the M6 diff. Flagged for a separate decision.

**Verified:** `npm run build` (stdio green) · `npm run typecheck:worker` green · `npx vitest run` **154 → 168
green** (14 new M6 tests) · `wrangler deploy` green. Live smoke: no-token
`/mcp`→401, AS/PRM metadata→200, malformed `/authorize`→400, `/health`→200, rate limiter→429+`Retry-After`.
Remote D1 still has **only** `users`/`clio_tokens`/`pending_auth` (no `audit_log`); `observability:false`.

**Still gated (operator):** `CLIO_CLIENT_ID`/`SECRET` are SET but unconfirmed-real (real-vs-placeholder needs an
interactive Clio login). Live two-user acceptance stays gated on a real private Clio app; isolation + hardening
are proven via the tests + deploy smoke above. `COOKIE_ENCRYPTION_KEY` is unset (the broker has no local consent
page, so the provider's consent-cookie path is bypassed).

## 2026-06-11 — M5 audit logging: kept but OFF by default (no DB deployed) + token-storage security pass

The M5 audit code (centralized append-only D1 `audit_log`) is **retained but disabled by default** behind
an `AUDIT_LOG_ENABLED` env var. The pilot deploys **no audit table** and persists **no** tool-call or
connection log unless an operator explicitly opts in. (This supersedes the earlier same-day removal —
commits `aa46fe4` added M5, `9a1798c` removed it, then it was restored gated on the operator's clarified
ask: keep the work, just gate it, and ensure no DB is deployed for it.)

Default-off, by design:
- **`env.ts`** — new `AUDIT_LOG_ENABLED?: string` var. **`mcp/api.ts`** only builds + attaches the audit
  writer when it is exactly `"true"`; otherwise no writer is attached and `upstream-shims/auditLog.ts`
  no-ops (its existing non-fatal early-return). So with audit off, the code never touches D1.
- **Migrations `0002`/`0003` live in the repo but are NOT applied** — the `audit_log` table + its
  append-only triggers do **not** exist on the remote D1 (only `users`/`clio_tokens`/`pending_auth`).
  `wrangler deploy` does not apply migrations, so deploying never creates the table.
- **`observability: false`** in `wrangler.jsonc` — no Workers request/connection logs persisted in
  Cloudflare either; `wrangler tail` still streams live for debugging.

To enable audit later: `wrangler d1 migrations apply clio-oauth-mcp --remote` (creates `audit_log` +
the append-only triggers), then set `AUDIT_LOG_ENABLED="true"`. The sink itself (redaction, per-user
attribution, durable+best-effort write, append-only DB triggers) is the reviewed M5 implementation —
see `docs/operations.md` for the schema, the export query, and the enable steps.

Token-storage security pass (operator asked to confirm storing tokens is safe — feature-dev reviewer,
**no P0**; all six properties **sound**): AES-256-GCM with a fresh 12-byte IV per record + auth-tag
enforced (tampering fails closed); strict `WHERE user_id = ?` isolation on every read/write, `userId`
sourced from the uninfluenceable access-token props; KV cache holds ciphertext only, keyed per-user,
invalidated on write; `ENCRYPTION_KEY` length-validated at import, no key material in code/logs; Leg-2
CSRF state single-use (`DELETE … RETURNING`) + expiry; code exchange requires `refresh_token`.
- **Applied (P2, defense-in-depth):** `auth/clio-handler.ts` `console.error` sites now log
  `err.message`, not the raw error object, so a future exception carrying response detail can't leak.
- **Deferred to M6 (P1, not currently exploitable):** `callbackRedirectUri` derives the redirect URI
  from the request host; Cloudflare sets the Host and Clio rejects any non-registered URI, so it's safe
  on the single workers.dev host — pin it to a `WORKER_BASE_URL` config value when a custom domain is added.

Verified: `npm run build` (stdio) + `typecheck:worker` + **154 tests** green (the M5 sink tests are back);
`wrangler deploy` live; remote D1 has only the token tables (no `audit_log`); no-token `/mcp` → 401,
AS metadata → 200.

---

## 2026-06-11 — M4: port the Clio tools (multi-tenant)

The 21 upstream Clio data tools now run per-user on the Worker, `clio_`-prefixed and annotated, each
acting as the authenticated caller's own Clio account. **No upstream `src/tools/**`, `src/utils/**`,
or `src/auth/**` file is edited** — all new code is under `src/remote/`, plus a wrangler `alias` map.

New modules (merge-safe):
- **`adapter/clioTools.ts`** — registration adapter. A Proxy over `McpServer.registerTool` prepends
  `clio_` and merges MCP annotations (PRD §M4: reads `readOnlyHint`/`openWorldHint`; the 8 writes
  `readOnlyHint:false`; `create_*` non-destructive, `update_task`/`complete_task` destructive).
  `registerClioDataTools` runs the 9 upstream `register*Tools` through it. `authenticate`/`logout`/
  `auth_status` (→ `clio_whoami`) and `export_audit_log` (→ M5 D1 export) are not ported.
- **`adapter/sessionContext.ts`** — the minimal upstream `SessionContext` the /mcp turn runs inside.
  Only `getAccessToken()` is real (resolves the user's token, memoized once per request; a failure is
  not memoized); the dropped-auth-tool members throw loudly (no ported data tool calls them).
- **`storage/kvTokenRepo.ts`** — KV read-cache decorator over `d1TokenRepo` for the hot per-tool-call
  read path (deferred from M3). Caches ciphertext+region only (never plaintext), keyed per-userId;
  writes invalidate; D1 stays authoritative.
- **`upstream-shims/{tokenStorage,auditLog}.ts`** — Worker-safe replacements for the Node-hostile
  upstream modules, swapped in **for the Worker build only** via wrangler `alias`. `tokenStorage`
  (OS keychain `@napi-rs/keyring` + `fs` + `os.homedir()` at load — none bundle/run on Workers) is
  unreachable here (the SessionContext is always populated) so it throws; `auditLog.appendAuditLog`
  is a no-op until M5's D1 sink. This is what lets the upstream tools bundle without a native addon.

Changed (merge-safe, worker-only):
- **`storage/tokenStore.ts`** — `updateTokens` is now a compare-and-set (`UPDATE … WHERE expires_at =
  <prev>`); `getValidClioToken` threads the pre-refresh expiry. A concurrent refresh of the same
  near-expiry token is a no-op instead of a lost write (deferred from M3; benign anyway — Clio refresh
  tokens are non-rotating).
- **`clio/connector.ts`** — `getUserClioToken` now resolves through the KV cache.
- **`mcp/server.ts`** — `buildMcpServer` also registers the 21 data tools (→ 23 tools incl. ping/whoami).
- **`mcp/api.ts`** — runs the whole MCP turn inside `sessionStorage.run(ctx)`, so every ported tool's
  `resolveAccessToken()` resolves THIS user's token via the AsyncLocalStorage seam — per-user injection,
  zero tool edits.
- **`wrangler.jsonc`** — `alias` map (the three upstream→shim entries).

Gotchas resolved (investigated, not assumed):
- **Bundling.** Importing the upstream tools pulls `clioClient → oauth → tokenStorage → @napi-rs/keyring`
  (a native addon esbuild can't bundle) + `fs`/`os.homedir()` at module load. Solved by aliasing the two
  Node-hostile modules to shims — verified the worker bundles, boots (59–64 ms), and the bundle is free of
  keyring/`appendFile`/`homedir`. `typecheck:worker` stays green (the upstream chain type-checks via the
  already-installed `@types/node`; no tsconfig change).
- **Region routing.** `clioClient.getBase()` reads `process.env.CLIO_REGION`, which `nodejs_compat`
  auto-populates from the `CLIO_REGION="EU"` var (compat date ≥ 2025-04-01), so all users route to
  `eu.app.clio.com` — correct for the single-region pilot. Only the token (not region) is injected;
  per-user region routing is **deferred** (would need the do-not-edit `clioClient` to read region from the
  context). Documented at the injection seam.
- **`fields` nesting depth (build-notes §10 spike #2 — resolved).** Clio supports one-level nested-association
  selection; **two-level returns 400**. All ported tools use only one level (`client{id,name}` etc.) — no
  two-level nesting anywhere — so no structural risk.

Review fixes applied (feature-dev reviewer, security-weighted; `/simplify` first):
- **`upload_document` is not registered** — it reads a local file by absolute path (`fs.stat`), which a
  Worker can't reach, so it would only ever error. Dropped from the remote surface (21 data tools, not 22);
  its read tools (`list_documents`/`get_document`) are network-only and stay. The only tool not ported.
- **Rejected token promise no longer poisons the turn** — a transient resolve failure clears the memo so
  the next tool call retries.
- `/simplify`: annotation table is a plain literal; auditLog shim reuses the upstream `AuditEntry` type;
  alias keys documented (the generic `./tokenStorage.js` key flagged).
- Confirmed sound: cross-user ALS isolation (fresh server/transport/ctx per request, turn wrapped in
  `sessionStorage.run`, memo closure-local per user), KV key strictly per-userId + ciphertext-only, the
  compare-and-set threading, annotation correctness, no token/PII in logs.

Verified: `npm run build` (stdio) + `typecheck:worker` + **138 tests** green; `wrangler deploy --dry-run`
+ `deploy` (live, boots in 64 ms); `/mcp` no-token → 401; both OAuth metadata endpoints → 200; the
23-tool surface + annotations asserted locally via the in-memory MCP client.

**PENDING (needs a real Clio private app — same gate as M3):** live per-user read-tool calls returning
real Clio data, and the M6 cross-user isolation test. Blocked on `CLIO_CLIENT_ID`/`SECRET` (a Leg-1 token
can't be minted without completing Leg-2), so authenticated `/mcp` calls can't run live yet.

---

## 2026-06-11 — M3: Leg 2 OAuth (us ⇄ Clio) + per-user encrypted token store

Each user now connects their own Clio account: `/authorize` redirects to Clio, `/clio/callback`
exchanges the code, reads `who_am_i`, encrypts+stores the per-user tokens, and mints the Leg-1 token
bound to the real Clio identity. `clio_whoami` proves it end-to-end. All new code under `src/remote/`;
**no upstream (`src/tools/**`, `src/auth/**`, `src/utils/**`) files touched.**

New modules (all merge-safe):
- **`storage/crypto.ts`** — AES-256-GCM via WebCrypto SubtleCrypto (random 12-byte IV/record, GCM tag,
  32-byte key from `ENCRYPTION_KEY`). Workers rewrite of upstream `tokenStorage.ts` (Node crypto/keyring/fs).
- **`storage/tokenStore.ts`** — per-user token store. **D1 is the source of truth** (read-your-writes for
  refresh correctness; KV cache deferred to M4's hot path). `getValidClioToken` decrypts + transparently
  refreshes + persists; `saveClioConnection` upserts. A `ClioTokenRepo` seam keeps the refresh/crypto logic
  unit-tested against real crypto with an in-memory repo; `d1TokenRepo` is the thin SQL adapter.
- **`clio/oauth.ts`** — Worker-native Clio OAuth client (region host map, authorize URL with **no scope**
  — app-level, code exchange via **`resp.json()`**, non-rotating refresh, `who_am_i`). Takes config
  explicitly — deliberately NOT the upstream `process.env`/loopback-`http` helpers (wrong source of truth
  in a multi-tenant Worker).
- **`clio/connector.ts`** — env→config glue + `getUserClioToken` (the per-user "act as this user" seam M4 reuses).
- **`auth/state.ts`** — Leg-2 CSRF: single-use random `state` in **D1** (not KV — the /authorize write and
  /clio/callback read straddle KV's ~60s consistency window), `DELETE…RETURNING` one-time consume, expiry.
- **`auth/clio-handler.ts`** — the Clio broker; replaces the M2 dummy `default-handler.ts` (deleted).
- **`migrations/0001_clio_connections.sql`** — `users` + `clio_tokens` (ciphertext) + `pending_auth`.

Changed (all merge-safe, worker-only):
- **`env.ts`** — `ConnectorProps` widened to `{ userId, clioUserId, clioRegion }`. **No Clio token in props**
  — the token stays in the encrypted store, resolved at tool-call time (confused-deputy boundary).
- **`mcp/server.ts`** — added `clio_whoami` (resolves+refreshes the user's token, live `who_am_i`, returns
  identity + token expiry). `buildMcpServer` now takes injected deps (`auth` + `whoami`).
- **`mcp/api.ts`** — builds the per-request `whoami` closure from props + env.
- **`worker.ts`** — `defaultHandler = clioHandler`. `userId = "clio-<clioUserId>"` (stable per user, no `:`,
  which the provider's token format reserves).

Security (reviewed — feature-dev reviewer, security-weighted; **no P0**):
- **Per-user isolation** (PRD §7 top invariant): token lookup is strictly `WHERE user_id = props.userId`,
  and `userId` is decrypted from the access-token props by the provider — uninfluenceable by the caller.
- Tokens **AES-256-GCM at rest, ciphertext only**; never in props, logs, URLs, or error messages.
- RFC 8707 `resource` still required at `/authorize` → every token audience-bound.
- Leg-2 CSRF: 256-bit random single-use `state`; a forged/replayed callback → 400 and never reaches
  `completeAuthorization` (which re-validates redirect_uri + PKCE). D1 queries fully parameterized; the
  callback error page interpolates no client input.
- **Review fixes applied:** `exchangeClioCode` throws if the code response omits `refresh_token` (don't
  persist an un-refreshable token); the Clio `error` query param is sanitized before logging (log-injection).
- **Known/deferred:** `redirect_uri` is request-host-derived (verified correct on the single workers.dev
  host; Clio rejects any non-registered URI, so not a security hole — pin to a config value if a custom
  domain/proxy is added, M6). Concurrent-refresh race is benign (Clio refresh tokens are non-rotating); a
  conditional `UPDATE` lands with M4's hot read path.

Setup + verified live (version `1f131744…`):
- `ENCRYPTION_KEY` generated + set (`wrangler secret`); `CLIO_CLIENT_ID`/`SECRET` set to **PLACEHOLDERs**
  pending a real Clio app. `.dev.vars` written (gitignored).
- D1 migration applied (remote); `users`/`clio_tokens`/`pending_auth` present; `DELETE…RETURNING` (the
  one-time state consume) confirmed working on D1.
- `/health` (M3 note); `/mcp` no-token → 401; `/authorize` → 302 to `eu.app.clio.com/oauth/authorize`
  with `redirect_uri=…/clio/callback` + random state; `pending_auth` row written; missing-`resource` → 400.
- `npm run build` (stdio) + **116 tests** + `typecheck:worker` green. `/simplify` + security review applied.

**PENDING (needs a real Clio private app):** the `/clio/callback` code exchange + `who_am_i` + token store +
`clio_whoami`, and the two-user acceptance — blocked on `CLIO_CLIENT_ID`/`SECRET` for an app whose redirect
URI is `https://clio-oauth-mcp.beatech.workers.dev/clio/callback`.

## 2026-06-11 — M2: Leg 1 OAuth (Claude ⇄ us) via `@cloudflare/workers-oauth-provider`

Wrapped the Worker in `new OAuthProvider({...})` so it is an OAuth 2.1 Authorization Server +
Resource Server for `/mcp`. Clio is not involved yet — `/authorize` approves a hardcoded dummy
identity (`dummy-user`); real per-user Clio login is M3. All new code under `src/remote/`; **no
upstream (`src/tools/**`) files touched.** `npm run build` (stdio) + 88 tests green; `typecheck:worker` clean.

- **[new, merge-safe] `src/remote/env.ts`** — `Env` bindings + the `OAUTH_PROVIDER: OAuthHelpers`
  the provider injects, plus `ConnectorProps` (the grant-props shape decrypted onto `ctx.props`).
  In its own module so the api + default handlers import it without an import cycle through `worker.ts`.
- **[new, merge-safe] `src/remote/mcp/api.ts`** — the provider `apiHandler` (apiRoute `["/mcp"]`).
  Reads the decrypted props off `c.executionCtx.props` and injects `{ userId }` into the
  per-request MCP server. Stateless serving stack unchanged from M1.
- **[new, merge-safe] `src/remote/auth/default-handler.ts`** — the provider `defaultHandler`:
  `/health`, the `/authorize` consent page (approve → `completeAuthorization` with dummy props),
  and the M3 `/clio/callback` 501 stub. Global `onError` → sanitized 500 + server-side `console.error`
  (the deferred-from-M1 error path, now that token/auth failures are real).
- **[edit, merge-safe] `src/remote/worker.ts`** — replaced the M1 Hono app + 501 stubs with
  `new OAuthProvider<Env>({ apiRoute:["/mcp"], apiHandler, defaultHandler, authorize/token/register
  endpoints, allowPlainPKCE:false })`. The provider now OWNS `/token`, `/register`, and the RFC 8414 /
  RFC 9728 metadata endpoints — the M1 501 stubs for those are **deleted** (not re-implemented).
- **[edit, merge-safe] `src/remote/mcp/server.ts` (+ test)** — `buildMcpServer(auth?)`; `clio_ping`
  echoes `authenticatedUser` (the injected subject). TDD: a new test asserts the echo over a real
  in-memory MCP client (no mocks of the server under test).

- **Spike resolved — `ctx.props` delivery (build-notes §10.1):** the plain object apiHandler form
  `{ fetch: api.fetch.bind(api) }` DOES surface props — no `WorkerEntrypoint` needed. The provider
  sets `ctx.props` on the **same** `ExecutionContext` it passes to `apiHandler.fetch(request, env, ctx)`
  (dist `oauth-provider.js` lines 2025 + 2054); Hono re-exposes it as `c.executionCtx.props`. Proven
  live: an authenticated `clio_ping` returns `authenticatedUser:"dummy-user"`.
- **Security — audience binding enforced server-side (security-weighted review finding).** The
  provider only validates token audience when one is present (`if (tokenData.audience)`), and an
  audience is only set when the client sends the RFC 8707 `resource` param. So a client that omits
  `resource` would get an audience-less token that passes the `/mcp` gate for any resource. `/authorize`
  now rejects a missing `resource` with 400 — every minted token is audience-bound to the canonical
  `/mcp` URL, closing the confused-deputy gap (build-notes §1). Verified live: wrong-audience token →
  401 "Invalid audience"; missing `resource` → 400.
- **OAuth 2.1 hardening:** `allowPlainPKCE:false` (S256-only, advertised in metadata); public-client
  DCR left enabled (Claude registers as a public + PKCE client).

- **Verified live** at `https://clio-oauth-mcp.beatech.workers.dev` (version `f211d9f4…`):
  - no-token `/mcp` → **401** + `WWW-Authenticate: Bearer realm="OAuth", resource_metadata=".../.well-known/oauth-protected-resource/mcp", error="invalid_token"`.
  - PRM `/.well-known/oauth-protected-resource/mcp` → `resource: .../mcp` (path-aware; **no host hardcoded** in TS). AS metadata → `code_challenge_methods_supported:["S256"]`, grants `authorization_code`+`refresh_token`.
  - Full dance (DCR → PKCE-S256 `/authorize` → `/token` → bearer `/mcp`) → `tools/call clio_ping` returns `authenticatedUser:"dummy-user"`. Wrong-audience and missing-`resource` rejected.
- **Quality gates:** `/simplify` (folded `ConnectorProps` into `env.ts`, dropped redundant `default`
  exports, trimmed a speculative props field) then a security-weighted code review (feature-dev
  reviewer) — its one actionable finding (audience enforcement, above) applied.
- **Carried to M3 (review notes, not M2 bugs):** the `/authorize` consent is GET-approve with a dummy
  identity (CSRF-moot while every grant is the same user); M3's real-user flow must POST/nonce the
  approval and HTML-escape any `ClientInfo` strings (`clientName`, `clientUri`, …) it renders.

## 2026-06-11 — M1: real Streamable HTTP `/mcp` + `clio_ping` (authless)

- **[new, merge-safe] `src/remote/mcp/server.ts`** — `buildMcpServer()` registers one no-op tool
  `clio_ping` (annotations `readOnlyHint`/`idempotentHint` true, `openWorldHint` false) returning a
  static `PING_PAYLOAD`. No Clio, no auth — that lands in M2+.
- **[new, merge-safe] `src/remote/mcp/__tests__/server.test.ts`** — TDD: a real MCP `Client` over
  `InMemoryTransport` asserts the tool list + the ping payload (no mocks of the server under test).
- **[edit, merge-safe] `src/remote/worker.ts`** — replaced the `/mcp` 501 stub with a Hono app +
  `@hono/mcp` `StreamableHTTPTransport` over the SDK's WebStandard transport. **Stateless:** fresh
  `McpServer`+transport per request, `sessionIdGenerator` undefined, `enableJsonResponse:true`. Health
  check + M2/M3 501 stubs preserved. (Worker-only file; not an upstream file — no merge risk.)
- **No upstream (`src/tools/**`, etc.) files touched.** `npm run build` (stdio) + 87 tests stay green;
  `typecheck:worker` clean.
- **Spike resolved — `@hono/mcp` stateless on Workers (build-notes §10.1):** verified live. With no
  `sessionIdGenerator`, the SDK transport's `validateSession()` short-circuits (no session, no
  "not initialized" gate), so single-shot `tools/list`/`tools/call` work without a prior `initialize`
  or `Mcp-Session-Id` — exactly the per-request shape MCP Inspector/Claude send.
- **Spike resolved — SDK #1944 JSON-only-`Accept` 406 (build-notes §10.1):** `@hono/mcp@0.3.0`
  defaults `strictAcceptHeader:false`, so a POST with `Accept: application/json` alone is honored, not
  406'd. Confirmed live: `initialize` with JSON-only Accept → 200 `application/json`. We do **not** set
  `strictAcceptHeader`. (Raw SDK transport would require both `application/json` + `text/event-stream`.)
- **Verified live** at `https://clio-oauth-mcp.beatech.workers.dev/mcp` (version `0b22cf8f…`): JSON-RPC
  `initialize` → `tools/list` (shows `clio_ping`) → `tools/call clio_ping` all 200 with expected payloads.
  This is the same Streamable-HTTP path MCP Inspector drives.

## 2026-06-11 — M0: fork + remote scaffold + pilot deploy

- **Forked** `oktopeak/clio-mcp` → `b0dea/clio-oauth-mcp` (GitHub fork network preserved). Local repo
  built on upstream `main` history (SHA `d85f3be`) with our work as commits on top, so
  `git merge upstream/main` keeps working. Remotes: `origin`=fork, `upstream`=oktopeak.
- **Baseline verified:** `npm install && npm run build` green (`build/index.js`). M0 accept met.
- **[new, merge-safe] `src/remote/`** — `worker.ts` (deployable skeleton: `/health` + 501 stubs),
  `README.md` (engineer milestone map). Plus `wrangler.jsonc`, `tsconfig.worker.json`.
- **[edit] `tsconfig.build.json`** — added `"src/remote/**"` to `exclude` so the stdio build ignores
  Worker code. Smallest diff; low conflict risk.
- **[edit] `package.json`** — added deps `@cloudflare/workers-oauth-provider@^0.7.2`, `@hono/mcp@^0.3.0`,
  `hono@^4.12.x`; devDeps `wrangler` + `@cloudflare/workers-types`; scripts `deploy`/`dev:worker`/`typecheck:worker`.
  MCP SDK (`^1.29.0`) + zod (`^3`) reused — all new deps install zod-3-clean.
- **[edit] `.gitignore`** — added `.mcp.json`, `.wrangler/`, `.dev.vars*`, `*.har`, `.worktrees/`.
- **MCP-transport decided — `@hono/mcp` + Hono, not `agents`.** `agents` peer-requires zod `^4` + the
  Vercel `ai` SDK v6 (non-optional), conflicting with upstream zod `^3`. SDK 1.29.0 ships a fetch-native
  WebStandard transport, so we serve `/mcp` with `@hono/mcp` on top of it — Workers-native, zod-3 clean,
  and its per-request Hono context maps onto upstream's `AsyncLocalStorage` token seam. FastMCP TS
  (forces zod 4) and FastMCP Python (abandons the TS fork) both rejected. (Evidence: research agent
  inspected the published tarballs.)
- **Provisioned pilot infra** (CF `Alex@beatech.dev`): D1 `clio-oauth-mcp`
  `8ed13620-de9b-4cfd-8c41-b97633576612` (region EEUR/EU), KV `OAUTH_KV` `198e446e34a24736a6cf60ae8427f5c6`,
  KV `CLIO_TOKENS` `486614165e2e4ce08aebadfe70d952cf`. Deployed skeleton →
  `https://clio-oauth-mcp.beatech.workers.dev` (`/health` 200, `/mcp` 501).
- **Docs:** `docs/migration.md` (GitHub org + CF account move) and `docs/operations.md`
  (deploy/secrets/audit/upstream-sync).

## Unreleased (pre-fork planning)

- **Planning only — no fork yet.** Added `docs/build-notes.md` (M0 research snapshot),
  `README.local.md` (deployment decision + §0 table), this changelog. Corrected the PRD's
  factual errors (write-tool count 2→9, areas 7→9, "ABA-Opinion-512" reframed, AES port→rewrite)
  and recorded the **single-firm / private-app / per-user-OAuth** deployment decision.
- **§0 values resolved (2026-06-11):** `CLIO_REGION=EU` (UK firm), `GITHUB_FORK_ORG=b0dea`,
  CF account `3699b6ddabe8729341468d6ebfe8a4ea`, `*.workers.dev` staging, `V1_WRITE_SCOPE=all`.
  Portability mandate: org/account/host/region/client-IDs in config+secrets+remotes only, never in code.
- **Audit pass (4 subagents, 2026-06-11).** Design confirmed: private-app multi-user OAuth, UK=EU,
  stateless `createMcpHandler` in `agents@0.15.0`, 26 tools / 9 writes, AsyncLocalStorage seam — all
  verified against primary sources. Doc fixes applied: MCP revision 2025-06-18→**2025-11-25** (DCR now
  MAY/CIMD-preferred); `fields` is effectively-not-strictly required + nesting depth flagged unsettled;
  OAuth host pinned to `eu.app.clio.com/oauth/*` (**not** `auth.api.clio.com` = different product);
  refresh non-rotating confirmed; `resolveAccessToken()` is in `clioClient.ts` not `sessionContext.ts`;
  `COOKIE_SECRET`→`COOKIE_ENCRYPTION_KEY`; write annotations corrected (`update_task`/`complete_task`
  `destructiveHint:true`); dropped the in-MCP `clio_export_audit` tool (cross-tenant leak) for a
  documented D1 export; added an intra-user write-risk note to §7.
- **SECURITY (action for operator — STILL OPEN):** `.mcp.json` holds a live GitHub PAT (`ghp_…`) +
  context7/context.dev keys. **Verified gitignored and absent from all git history** (never committed) as of
  M1, so it is not in the repo — but it sits in plaintext on the dev machine, so **rotate the GitHub PAT**
  and treat it as exposed. Unrelated to the connector's own secrets (those go through `wrangler secret`).
- Baseline upstream: `@oktopeak/clio-mcp@2.0.0` (MIT). Upstream SHA at fork: `d85f3be` ("README: link to
  Windows install guide blog post") — our work sits as commits on top; `git merge upstream/main` stays clean.

<!--
Template for real entries once the fork exists:

## <date> — <short title>
- [new module] src/<area>/<file> — <what/why>. Merge-safe.
- [edit] src/<upstream file> — <smallest-possible diff + why>. Conflict risk on next sync.
- Upstream merged to SHA <sha>; tag upstream-sync/<date>.
-->
