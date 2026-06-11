# Build Notes — Clio Remote MCP Connector

> M0 deliverable (PRD §5). Snapshot of the **verified-current** APIs, packages, and
> architecture this build depends on. Versions/URLs verified **2026-06-11** by live
> docs + npm; the PRD mandates re-checking at build time, so treat this as a snapshot,
> not a contract. Anything not directly confirmed is marked **(verify)**.

---

## 0. Deployment model (decided)

**Single-firm, private Clio app, per-user OAuth. No public connector, no Clio App Directory listing.**

**Resolved values (2026-06-11):** firm is **UK** → `CLIO_REGION=EU` (`eu.app.clio.com`); fork owner `b0dea`;
deploy to CF account `Alex@beatech.dev's Account` (`3699b6ddabe8729341468d6ebfe8a4ea`); `*.workers.dev`
staging; `V1_WRITE_SCOPE=all` (register all 26 tools, Clio app read/write, per-tool gating left to Claude
Desktop). **Portability requirement:** org/account/hostname/region/client-IDs live in `wrangler.jsonc` +
secrets + git remotes only — never hardcoded in TypeScript — so git/CF/domain can be re-pointed without code changes.

- One Worker deployment serves **one law firm** (= one Clio account, many users).
- One **private** Clio developer app, registered against that firm's own Clio account.
  Private apps need **no Clio security/compliance review and no App Directory listing** —
  that gate only applies to public apps used across *different* firms, which we are not building.
- Each attorney adds the custom connector by URL in Claude Desktop, clicks **Connect**,
  logs into **their own** Clio account, and is done. No API keys, no per-user app setup.
- **API-key fallback is not used.** Clio has no user-facing API keys; the only non-OAuth
  path would be each user registering their own dev app (high friction) — explicitly rejected.

**Confirmed (2026-06-11 audit):** a single private app accepts OAuth from multiple distinct
users within the one firm, each receiving their own token — Clio docs state "each firm user
will need to be authorized in this manner to connect their Clio account to the private application." If a firm later wants *other* firms to connect the same
deployment, that becomes a public app and triggers Clio's review — out of scope here.

---

## 1. The two OAuth legs

```
Claude Desktop ──(Leg 1: OAuth 2.1, we are the AS+RS)──▶  our Worker  ──(Leg 2: OAuth client)──▶  Clio
   click Connect, DCR + PKCE S256                        per-user token store          attorney's own Clio login
```

- **Leg 1 (Claude ⇄ us):** our Worker is an OAuth 2.1 Authorization Server **and** Resource
  Server for `/mcp`. Provided almost entirely by `@cloudflare/workers-oauth-provider`.
- **Leg 2 (us ⇄ Clio):** our Worker is an OAuth client of one private Clio app. We write this
  handler (swap of Cloudflare's GitHub-OAuth template).
- **Security crux:** mint Leg-1 access tokens with `aud` = our canonical `/mcp` URL and reject
  anything else. The Clio token is a *separate* token — never pass it through to Claude, never
  pass the Claude token to Clio (confused-deputy boundary, MCP spec / RFC 8707).

---

## 2. Verified package + protocol versions

| Thing | Verified value | Role |
|---|---|---|
| MCP protocol revision | **2025-11-25** (current; `2025-06-18` also Final) | Streamable HTTP is current; HTTP+SSE deprecated |
| `@modelcontextprotocol/sdk` | **1.29.0** | MCP server primitives; ships the **fetch-native** `WebStandardStreamableHTTPServerTransport` (`handleRequest(Request)→Response`, no Node http); upstream pins `^1.29.0` (aligned) |
| `@cloudflare/workers-oauth-provider` | **0.7.2** | Leg-1 OAuth 2.1 AS (DCR, /authorize, /token, PKCE, metadata); passes the authed user's `props` to the api handler via `ctx.props` |
| `@hono/mcp` | **0.3.0** | Serves Streamable-HTTP MCP on Workers (`StreamableHTTPTransport.handleRequest(c)`); wraps the SDK WebStandard transport; zod-3 clean |
| `hono` | **4.12.x** | Worker router; peer of `@hono/mcp` (the MCP SDK also depends on hono) |
| `@modelcontextprotocol/inspector` | **0.22.0** | Test client for the deployed `/mcp` |
| `wrangler` | **4.99.0** | Deploy CLI; config in `wrangler.jsonc` |
| Upstream `@oktopeak/clio-mcp` | **2.0.0** (MIT, May 2026) | The fork base |

> Do **not** hardcode these from memory in a future session — re-resolve against npm.

**MCP-transport decision (why not Cloudflare's `agents` SDK):** `agents` peer-requires zod `^4` and
the Vercel `ai` SDK v6 (both non-optional), which collides with upstream's zod `^3` and would force a
risky zod-4 upgrade of the 26 tool schemas. Since SDK 1.29.0 now ships the fetch-native WebStandard
transport, we serve `/mcp` with **`@hono/mcp` on top of it** — Workers-native, zod-3 clean, and its
Hono per-request context maps straight onto upstream's `AsyncLocalStorage` token seam. `agents` is not
used. (Inspecting the `agents@0.15.0` tarball: `createMcpHandler`'s runtime path doesn't import `ai`,
but the install-time peer check + zod-4 authoring make it not worth fighting.)

---

## 3. Leg 1 — what Cloudflare gives us free vs. what we write

**Free from `@cloudflare/workers-oauth-provider@0.7.2`:** the whole AS surface —
`/register` (DCR, RFC 7591), `/authorize`, `/token` (code + refresh, with rotation),
PKCE S256, `/.well-known/oauth-authorization-server` (RFC 8414) and
`/.well-known/oauth-protected-resource` (RFC 9728), token issuance/validation, and
end-to-end-encrypted `props` storage in a `OAUTH_KV` namespace (keyed by token hash).

Constructor wires our pieces in:
```ts
export default new OAuthProvider({
  apiHandler: /* our stateless MCP handler */,
  apiRoute: "/mcp",
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  defaultHandler: ClioHandler,   // the only upstream-specific file we write (Leg 2)
});
```

**We write:** the `ClioHandler` (Leg 2, below) and the per-user Clio **token store** (§5).
We also enforce **`aud` validation** on every `/mcp` request — the provider supports
audience binding but we configure `resourceMetadata` and verify it ourselves.

**Claude connector facts (verified):** custom connectors are added by URL; on 401 Claude reads
`WWW-Authenticate: Bearer resource_metadata="…"` → RFC 9728 → RFC 8414 → DCR + PKCE S256.
(The current `2025-11-25` spec downgrades DCR to MAY and prefers CIMD, but `workers-oauth-provider`
ships DCR and Claude still supports it — DCR is fine to use here.)
Hosted redirect URI is `https://claude.ai/api/mcp/auth_callback` (exact-match register).
The PRM `resource` field **must exactly match** the URL the user types in Claude (incl. path),
and must align with the token `aud`.

---

## 4. Leg 2 — GitHub→Clio swap (the one handler we own)

Base template: `cloudflare/ai` → `demos/remote-mcp-github-oauth`. The OAuth *plumbing* is
GitHub-agnostic and reused as-is. The upstream bridge (`github-handler.ts` + `utils.ts`) is
~100 lines; we rewrite it as `ClioHandler`:

1. `/authorize` → redirect to Clio `…/oauth/authorize` (region host, §6) with `response_type=code`,
   `client_id`, `redirect_uri`, `state`. (Clio takes **no** `scope` param — scope is app-level.)
2. `/clio/callback` → exchange code at `…/oauth/token` (form-encoded).
   **Gotcha:** the template parses the token response with `resp.formData()` (GitHub-specific).
   **Clio returns JSON → change to `resp.json()`** and send `Accept: application/json`.
3. Fetch identity: `GET /api/v4/users/who_am_i?fields=id,name,email` → map to our user record.
4. `env.OAUTH_PROVIDER.completeAuthorization({ userId, scope, props, request })` → mints our Leg-1 token.
5. Persist Clio `access_token` + `refresh_token` + `expires_in` + region in our encrypted store (§5).
   GitHub tokens never expire, so the template models **no upstream refresh** — that is net-new for us.

Drop the template's Octokit / AI / image-gen scaffolding. Secrets: `CLIO_CLIENT_ID`,
`CLIO_CLIENT_SECRET`, plus `COOKIE_ENCRYPTION_KEY` (template's consent-cookie signer).

---

## 5. Storage + crypto

- **WebCrypto `SubtleCrypto` AES-256-GCM** is fully supported on Workers (12-byte IV per record,
  key derived from `ENCRYPTION_KEY` secret via HKDF/PBKDF2). This is the **rewrite** of upstream's
  `tokenStorage.ts` (upstream uses Node `crypto` + 16-byte IV + OS keychain/file — all Workers-hostile).
- **D1 = primary** token store (read-your-writes; matters for refresh races). **KV = cache.**
  Do not treat KV as source of truth for a token you just wrote (KV is eventually consistent,
  ~60s propagation, 1 write/sec/key hot-key limit).
- Tables: `users` (user_id, clio_user_id, clio_region, ts) and `audit_log` (append-only, §7).
- Secrets via `wrangler secret put`: `ENCRYPTION_KEY`, `CLIO_CLIENT_ID`, `CLIO_CLIENT_SECRET`,
  `COOKIE_ENCRYPTION_KEY`. Nothing sensitive in the repo.

The Cloudflare OAuth provider already encrypts its own `props` with the bearer token as key
material — but that's only readable *with a live token*. We need our **own** AES-256-GCM store so
the server can refresh Clio tokens out-of-band. Hence the separate `ENCRYPTION_KEY`-based layer.

---

## 6. Clio Manage v4 — confirmed constraints

- **OAuth endpoints (US):** authorize `https://app.clio.com/oauth/authorize`,
  token `https://app.clio.com/oauth/token`, deauthorize `…/oauth/deauthorize`.
- **Regional API bases:** US `app.clio.com`, EU `eu.app.clio.com`, CA `ca.app.clio.com`,
  AU `au.app.clio.com` — all under `/api/v4`. **Tokens are region-bound** (a US token is invalid
  against EU/CA/AU). Store each user's region; route OAuth **and** API calls to the matching host.
  **OAuth lives on the same regional host** — for our EU firm: `https://eu.app.clio.com/oauth/{authorize,token}`.
  Do **not** use `auth.api.clio.com`; that host is the separate *Clio Platform* product, not Clio Manage v4.
- **Scopes are app-level**, set in the Developer Portal as read-only or read/write **per category**,
  and **locked at authorization** — changing them forces every user to re-authorize. There is no
  per-request `scope`. → `V1_WRITE_SCOPE` is an **app-registration decision**, app-wide.
- **`fields` effectively required** (not enforced — omitting it returns `id`+`etag` only, no error).
  Comma-separated; nested-association selection (`matter{id,display_number}`) with an unsettled depth
  limit (one vs two levels; second level returns defaults only) — verify against the live `fields`
  doc; no wildcard syntax. Each tool must declare the fields it needs.
- **Pagination:** `meta.paging.next` / `previous` (opaque URLs). Max `limit` **200**. No total-count
  field. `has_more = meta.paging.next != null`. Cursor mode needs `order=id(asc)`.
- **Rate limit is per access token** (multi-tenant-friendly): headers `X-RateLimit-Limit/Remaining/Reset`;
  on exceed → `429` + `Retry-After`. Documented **~50 req/min peak**. Upstream already implements
  429/`Retry-After` backoff (`RETRY_DELAYS_MS = [1000, 2000, 4000]`).
- **Tokens:** access `expires_in` = **30 days** (2592000s); refresh tokens **don't expire** and are
  **non-rotating** (the refresh response omits a new `refresh_token`).
- **Identity:** `GET /api/v4/users/who_am_i?fields=id,name,email`.

---

## 7. Upstream fork — port map (`@oktopeak/clio-mcp@2.0.0`)

The codebase is unusually well-shaped for this port. Keep tool files **untouched**; all new
concerns live in new modules (PRD §8).

**Reuse as-is (no edits):**
- `src/utils/clioClient.ts` — centralized `clioGet/clioPost/clioPatch/clioPut`, `ClioApiError`,
  `getClioBaseUrl`, `extractNextPageToken`. Native `fetch` (Workers-OK). 429 backoff already here.
- `src/utils/sessionContext.ts` — **`AsyncLocalStorage<SessionContext>`** + `getSessionContext()`. The
  accessor `resolveAccessToken()` actually lives in `clioClient.ts` and reads that per-request context,
  so **there is no module-global token**. This is the injection seam:
  build a `SessionContext` whose `getAccessToken()` pulls from our encrypted store, then
  `sessionStorage.run(ctx, () => handleRequest(...))`. **Per-user injection with zero tool edits.**
  (`AsyncLocalStorage` works on Workers with `nodejs_compat`.) Note: `resolveAccessToken()` has a stdio
  fallback (`getValidAccessToken()` → disk read / browser OAuth) — **always populate the context** so
  that fallback never fires on Workers.
- `src/auth/oauth.ts` pure helpers — `buildAuthorizationUrl`, `exchangeCodeForTokensPure`,
  `refreshTokensPure`, `getValidAccessToken`. Reusable for Leg 2 logic.

**Rewrite (Node-host → Workers), keep exported signatures identical so upstream callers merge clean:**
- `tokenStorage.ts` → SubtleCrypto + D1/KV (was Node `crypto` + keychain/fs).
- `auditLog.ts` → D1 sink (was `fs.appendFile` JSONL). Keep `redactArgs()`.
- loopback OAuth in `oauth.ts` (`runOAuthFlow` + `open`) → hosted `/clio/callback`.

**Adapters (new, no tool edits):**
- `clio_` name prefix → wrap `McpServer.registerTool` to prepend the prefix (~10 lines).
- Drop `authenticate`/`logout` (auth is connector-level now); replace `auth_status` → `clio_whoami`;
  replace local `export_audit_log` → D1 export / `clio_export_audit`.

**Workers-hostile deps to remove from the Worker entrypoint:** `@napi-rs/keyring`, `express`,
`open`, `dotenv`. Add a separate `src/worker.ts` entrypoint; leave `index.ts` (stdio) and
`server/http.ts` (express) importable-but-unused so upstream diffs stay mergeable.

---

## 8. Tool inventory (26 tools) — PRD corrections baked in

**9 resource areas (PRD said 7).** **9 write tools (PRD said 2).** Connector-internal auth/audit
tools get replaced per §5/M3/M5.

| Area | Read | Write |
|---|---|---|
| Matters | `list_matters`, `get_matter` | `create_matter` |
| Contacts | `search_contacts`, `get_contact` | — |
| Documents | `list_documents`, `get_document` | `upload_document` (POST→PUT→PATCH) |
| Tasks | `list_tasks` | `create_task`, `update_task`, `complete_task` |
| Calendar | `list_calendar_entries`, `list_calendars` | `create_calendar_entry` |
| Activities/Time | `list_time_entries` | `log_time_entry`, `create_activity` |
| Billing | `get_billing_summary` | — |
| Notes | — | `create_note` |
| Users | `list_users`, `get_user` | — |
| Connector-internal | `auth_status`→`clio_whoami`, `export_audit_log`→D1 export | `authenticate`/`logout` → **dropped** |

**Write tools (9):** `create_matter`, `upload_document`, `create_task`, `update_task`,
`complete_task`, `create_calendar_entry`, `log_time_entry`, `create_activity`, `create_note`.
If `V1_WRITE_SCOPE=read-only`, gate **all nine** in the `registerTool` adapter — and set the
Clio app's permissions to read-only too (scope is app-level, §6).

---

## 9. "ABA-Opinion-512" — framing, not a feature

Upstream's "ABA-Opinion-512 audit logging" is marketing copy (README / package keywords / a
`clio://compliance/notice` resource). In code it's a **generic JSONL tool-call audit log** with
key-based redaction — no ABA construct. Preserve the *structured audit* behavior; don't chase a
feature that isn't there.

---

## 10. Open items to resolve before/at M0–M3

**Confirmed by the 2026-06-11 audit (no longer open):** private-app multi-user OAuth within one firm;
UK = Clio **EU** region (`eu.app.clio.com`, no UK subdomain); OAuth on the same regional host (not
`auth.api.clio.com`); refresh tokens non-rotating + non-expiring; all package versions; 26 tools / 9 writes;
the AsyncLocalStorage injection seam; the MCP SDK ships a fetch-native WebStandard transport so the
MCP-serving stack is **Hono + `@hono/mcp`** (no `agents`); these install zod-3-clean (verified).

**Resolved at M1 (2026-06-11, verified live):**
1. `@hono/mcp`'s `StreamableHTTPTransport` works stateless on the deployed Worker with
   `enableJsonResponse:true` (no `sessionIdGenerator`): single-shot `tools/list`/`tools/call` need no
   session and no prior `initialize` — the SDK transport's `validateSession()` short-circuits when
   stateless, and `McpServer` has no init gate. SDK #1944 is avoided: `@hono/mcp@0.3.0` defaults
   `strictAcceptHeader:false`, so a JSON-only `Accept: application/json` returns 200, not 406 (we leave
   it at the default). Evidence in `CHANGELOG.local.md` (M1).

**Resolved at M2 (2026-06-11, verified live):**
1. **`ctx.props` reaches the api handler with the plain `{ fetch }` form** — no `WorkerEntrypoint`
   needed. `workers-oauth-provider` sets `ctx.props` on the *same* `ExecutionContext` it then passes
   to `apiHandler.fetch(request, env, ctx)` (`dist/oauth-provider.js` lines 2025 + 2054, `handleApiRequest`);
   Hono re-exposes that object as `c.executionCtx.props`. So `apiHandler: { fetch: api.fetch.bind(api) }`
   delivers the decrypted grant props. Proven live: an authenticated `clio_ping` echoes the injected
   `authenticatedUser`. Audience binding is provider-driven off the client's RFC 8707 `resource` param;
   we additionally **require** `resource` at `/authorize` so a resource-less client can't obtain an
   audience-less (unbound) token (the provider only audience-checks tokens that *have* an audience).
3. **Global Hono `app.onError`** (sanitized 500 + server-side `console.error`) added to both the api
   and default handlers, plus `try/catch` around the `parseAuthRequest` / `completeAuthorization` paths
   (bad-client requests → 400, non-revealing). This is the deferred-from-M1 error path (PRD §7).

**Still to settle at build time:**
2. Confirm the exact `fields` nesting depth (one vs two levels) against the live Clio `fields` doc (M4).
