# CHANGELOG (local) — deltas vs. upstream `oktopeak/clio-mcp`

Running log of every change we make on top of upstream, so `git merge upstream/main` stays
reasoned-about. Record the upstream commit SHA after each sync and tag `upstream-sync/<date>`.

Format: newest first. Note **why**, and whether a change edits an upstream file (conflict risk)
or adds a new module (merge-safe).

---

## 2026-06-11 — M5 audit logging: added, then removed (no hosted logs for the pilot)

M5 (centralized append-only D1 `audit_log`) was built, reviewed, and deployed earlier today, then
**fully reverted** the same day on the operator's decision: **the pilot will not host any audit log or
connection log** in Cloudflare (or anywhere) for now — we just need the MCP↔Clio OAuth connection.
Net delta vs upstream from M5 is therefore **zero**; this entry records the round-trip so the history
is honest.

Removed (was M5, now gone):
- `src/remote/storage/auditStore.ts` (+ its test) and `src/remote/upstream-shims/__tests__/auditLog.test.ts`.
- `migrations/0002_audit_log.sql` + `migrations/0003_audit_log_append_only.sql`. The `audit_log` table
  and its append-only triggers were **dropped from the remote D1**, and the `0002`/`0003` rows removed
  from `d1_migrations` — remote is back to `0001` only.
- The wiring in `mcp/api.ts`, `adapter/sessionContext.ts`, `env.ts`, and `upstream-shims/auditLog.ts`
  was reverted to the M4 state. The shim is again a **no-op** (it must still exist — the 21 tools import
  it via the wrangler `alias`, and it keeps the fs-backed upstream module out of the Worker bundle).

Kept (these are the OAuth connection, not logs):
- The D1 token store (`users`, `clio_tokens`, `pending_auth`) and both KV namespaces. Per-user Clio
  tokens must persist (encrypted) so the connection can refresh them — deleting them would break Leg 2.
- **`observability` set to `false`** in `wrangler.jsonc`: the pilot persists no Workers request/connection
  logs in Cloudflare. Live debugging still works via `wrangler tail` (real-time, independent of this).

If audit logging is wanted later, it's a clean re-add (a sink module + a migration + a few lines of
api.ts wiring); design notes are in this CHANGELOG's git history (commit `aa46fe4`).

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
