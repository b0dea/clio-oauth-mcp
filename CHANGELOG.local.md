# CHANGELOG (local) — deltas vs. upstream `oktopeak/clio-mcp`

Running log of every change we make on top of upstream, so `git merge upstream/main` stays
reasoned-about. Record the upstream commit SHA after each sync and tag `upstream-sync/<date>`.

Format: newest first. Note **why**, and whether a change edits an upstream file (conflict risk)
or adds a new module (merge-safe).

---

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
