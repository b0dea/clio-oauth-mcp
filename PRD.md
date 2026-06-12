# PRD — Clio Remote Multi-Tenant MCP Connector

**Audience:** an autonomous coding agent (Claude Code / agentic session).
**Goal:** turn a local, single-user Clio MCP server into a **remote, multi-user** MCP connector that a law firm adds **once** as a custom connector (Claude Desktop / Team / Enterprise), where **each user authenticates with their own Clio account** via OAuth — one click of "Connect" per attorney, nothing else.
**Build strategy:** **fork** `oktopeak/clio-mcp` and keep it merge-friendly so upstream fixes can be pulled indefinitely.

**Deployment model (decided — see `README.local.md` / `docs/build-notes.md`):** **single-firm, private Clio app, per-user OAuth.** "Multi-tenant" here means *multi-user within one law firm* (one Clio account, many users), **not** a public connector shared across different firms. This avoids Clio's public-app review/App Directory gate entirely — a **private** Clio app needs no Clio approval. **Security correction (M8):** a Clio *Manage* private app is **not firm-bound** — "private" only means unlisted, so any Clio user could authorize. The single-firm restriction is therefore enforced by an **application-level allowlist** (`ALLOWED_EMAIL_DOMAINS`/`ALLOWED_CLIO_USER_IDS`, checked against `who_am_i`, fail-closed; §7/§M6), **not** by Clio. There is **no API-key fallback**: Clio is OAuth-only, and per-user OAuth via a private app is the lowest-friction path that works.

> Read this whole document before writing code. Several sections constrain *how* you implement, not just *what*. The hard part is auth and upstream-merge discipline, not the Clio tools (those already exist in the fork).
>
> **Verified corrections applied (2026-06-11):** upstream has **9 write tools, not 2**; **26 tools across 9 resource areas, not 7**; "ABA-Opinion-512" is marketing framing, not a code feature; the AES-256-GCM helper is **rewritten** for Workers SubtleCrypto, not ported. Details in `docs/build-notes.md`.

---

## 0. Fill these in before starting

These are the only project-specific unknowns. Resolve them (ask the operator if unset) and record the answers at the top of `README.local.md` in the repo.

| Key | Value | Notes |
|---|---|---|
| `GITHUB_FORK_ORG` | `b0dea` (personal, for now) | Owns the fork; lives only in git remotes (never in code) so a later org move is one `git remote set-url`. |
| `CLOUDFLARE_ACCOUNT` | `Alex@beatech.dev's Account` (`3699b6ddabe8729341468d6ebfe8a4ea`) | Personal CF account; set as `account_id` in `wrangler.jsonc`. |
| `WORKER_HOSTNAME` | `*.workers.dev` (staging; custom domain TBD) | Swap via `routes`/`name` in `wrangler.jsonc`, no source change. |
| `CLIO_REGION` | `EU` → `eu.app.clio.com` | UK firm → Clio EU region. Worker var; drives all Clio base + OAuth URLs. |
| `V1_WRITE_SCOPE` | `read-only` (default; `all` to enable writes) | Read-only by default — only read tools registered. `=all` advertises the write tools (set the Clio app read/write to match). Users gate per-tool in Claude; each acts only on their own Clio with their own Clio-side permissions. |
| `FIRM_ALLOWLIST` | `ALLOWED_EMAIL_DOMAINS` / `ALLOWED_CLIO_USER_IDS` (required, fail-closed) | Restricts login to the firm (a Clio Manage private app is not firm-bound). Checked against `who_am_i` at `/clio/callback`. |
| `DEPLOYMENT_MODEL` | `single-firm` (decided) | One private Clio app per firm's Clio account; per-user OAuth; no public App Directory listing. |

Values resolved 2026-06-11 (recorded in `README.local.md`). **Built for portability** — nothing project-specific (org, account, hostname, region, client IDs) is hardcoded in TypeScript; it's all `wrangler.jsonc` config + `wrangler secret` + git remotes, so the operator can re-point git/CF/domain without code changes.

---

## 1. Context and decision already made

There is no official Clio MCP server. Of the open-source options, `oktopeak/clio-mcp` has the widest coverage (26 tools across 9 Clio resource areas) and already implements Clio OAuth, AES-256-GCM token encryption, and structured per-user audit logging (upstream brands this "ABA-Opinion-512"; in code it is a generic JSONL tool-call log) — **but it is stdio/local/single-user**, launched from `claude_desktop_config.json` on each machine.

A Claude **custom connector** is added by URL and reached from Anthropic's cloud, so it must be a **remote** MCP server over Streamable HTTP. Gateways (Zapier/viaSocket) are remote but expose a **single shared Clio identity**, which breaks per-attorney permissions, conflicts/ethical walls, and the audit trail. Therefore: **self-host a remote server with a per-user OAuth broker.** That is what this PRD specifies.

The Clio side is **one private developer app** registered against the firm's own Clio account. Clio apps start **private = single-firm**, which is exactly our case and needs **no Clio review or App Directory listing**; each of the firm's users authorizes that same private app with their own Clio login and receives their own token. (The public-app review gate only applies if a single deployment were to serve *different* firms — out of scope.) Confirm at build time that a private app accepts OAuth from multiple users within the one firm.

---

## 2. Scope

### In scope (v1)
- Fork of `oktopeak/clio-mcp`, restructured so the **Clio tool implementations are inherited largely untouched** and all new concerns live in new modules.
- **Streamable HTTP** transport (stateless JSON), deployed on **Cloudflare Workers**.
- **Two-leg OAuth broker:**
  1. **Claude ⇄ our server** — our server is an OAuth 2.1 Authorization Server + Resource Server for the MCP endpoint (Dynamic Client Registration, Authorization Code + PKCE/S256).
  2. **Our server ⇄ Clio** — our server is an OAuth client of Clio; each user authorizes their own Clio account.
- **Per-user encrypted Clio token storage** with strict per-user isolation.
- **Centralized append-only audit log** (per-user), preserving the ABA-512 properties.
- Clio API client with **pagination, field-selection, and 429/backoff** handling.
- Org-connector wiring instructions + MCP Inspector test path.
- Evaluations (read-only) per MCP build guidance.

### Out of scope (v1) — non-goals
- No zero-touch auth. Per-user Clio OAuth is **required by design**; do not try to share or pre-seed tokens.
- No write surface beyond what `V1_WRITE_SCOPE` allows. **Upstream exposes 9 write tools**, not 2: `create_matter`, `upload_document`, `create_task`, `update_task`, `complete_task`, `create_calendar_entry`, `log_time_entry`, `create_activity`, `create_note`. `read-only` must gate **all nine** (in the adapter layer), and the Clio app's permission set must match.
- No UI, no admin dashboard, no non-Clio DMS support.
- No rewrite of the Clio tool logic. If a tool is wrong, fix it **upstream-style** in an isolated patch (see §8), don't refactor the file.

---

## 3. Architecture

```
                         ┌─────────────────────────────────────────────┐
   Attorney's Claude     │            Cloudflare Worker                 │
   (Team/Ent connector)  │                                             │
        │                │  /.well-known/oauth-protected-resource      │
        │  OAuth 2.1     │  /.well-known/oauth-authorization-server    │
        │  DCR + PKCE    │  /register  /authorize  /token              │  ← Leg 1: we are the AS
        ├───────────────▶│                                             │
        │                │  /clio/callback                             │  ← Leg 2: we are a Clio
        │  MCP calls     │  /mcp   (Streamable HTTP, stateless JSON)    │     OAuth *client*
        ├───────────────▶│        │                                    │
        │                │        ├── auth middleware (validate our    │
        │                │        │    token, resolve user_id)         │
        │                │        ├── per-user Clio API client         │──────▶  Clio Manage v4 API
        │                │        ├── 26 inherited Clio tools          │         (region-specific)
        │                │        └── audit logger                     │
        │                │                                             │
        │                │  Bindings: D1 (users, audit), KV (tokens),  │
        │                │  Secrets: ENCRYPTION_KEY, CLIO_CLIENT_ID,   │
        │                │   CLIO_CLIENT_SECRET, COOKIE_ENCRYPTION_KEY │
        └────────────────┴─────────────────────────────────────────────┘
```

**Identity flow (the crux):**
1. User clicks **Connect** on the org connector → Claude does DCR against `/register`, then hits `/authorize` with PKCE.
2. `/authorize` creates a pending session, then redirects the user to **Clio's** `/oauth/authorize`.
3. Clio redirects back to `/clio/callback`; we exchange the code for Clio access+refresh tokens, fetch the Clio `user_id`, create/lookup our `user` record, **encrypt and store** the Clio tokens keyed to that user.
4. We complete Leg 1 by issuing **our own** access token to Claude, bound to `user_id` (audience = our MCP resource).
5. Every `/mcp` request carries our token → middleware validates audience + resolves `user_id` → tool calls use **only that user's** Clio tokens.

**Recommended implementation shortcut:** use Cloudflare's OAuth provider library for Leg 1 and the MCP-agent pattern for the Streamable HTTP server, with **Clio as the upstream identity provider** (analogous to Cloudflare's "remote MCP server with auth" template that uses GitHub upstream — swap GitHub → Clio). **Do not hardcode package names or versions from memory** — fetch current docs in M0 (§5) and use what's current. The M0 research snapshot (verified package names/versions, the GitHub→Clio swap, and the upstream port map) is captured in **`docs/build-notes.md`** — start there, then re-confirm against npm. One concrete swap gotcha already found: the template parses the upstream token response with `resp.formData()` (GitHub-specific); **Clio returns JSON → use `resp.json()`**.

---

## 4. Required reading (fetch at build time, do not rely on training data)

Pull these before/while coding; APIs and versions move:
- MCP spec — start at `https://modelcontextprotocol.io/sitemap.xml`, then fetch transport + authorization pages with `.md` suffix. Confirm current **Streamable HTTP** + **OAuth 2.1 / protected-resource-metadata (RFC 9728) / DCR (RFC 7591) / PKCE** requirements.
- MCP TypeScript SDK README — `https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/README.md`.
- Cloudflare: current docs for "remote MCP server" and the Workers **OAuth provider** library (`@cloudflare/workers-oauth-provider`). NOTE: we do **not** use the `agents`/`McpAgent` pattern — it forces zod 4 and the Vercel `ai` SDK, conflicting with upstream's zod 3. We serve `/mcp` with **`@hono/mcp`** on the MCP SDK's fetch-native WebStandard transport instead. See `docs/build-notes.md` §2.
- Clio Manage API v4 docs: OAuth endpoints, **`fields` parameter requirement**, pagination (`meta.paging` / `X-RateLimit` / `429 Retry-After`), and the regional base URLs.
- Upstream `oktopeak/clio-mcp` source — inventory the 26 tools, the AES-256-GCM helper, and the audit-log format so you can preserve them.

---

## 5. Milestones (execute in order; each has acceptance criteria — checkpoint before proceeding)

### M0 — Fork + repo hygiene + docs
- Fork `oktopeak/clio-mcp` into `GITHUB_FORK_ORG`.
- `git remote add upstream https://github.com/oktopeak/clio-mcp.git`; verify `git fetch upstream` works.
- Create `README.local.md` (fill the §0 table) and `CHANGELOG.local.md` (running list of deltas vs upstream).
- Fetch all §4 docs; write a 1-page `docs/build-notes.md` summarizing the current MCP remote-auth + Cloudflare APIs you'll use (with the actual package/template names you found).
- **Accept:** fork builds clean as-is (`npm install && npm run build`); upstream remote fetches; build-notes committed.

### M1 — Bare remote MCP on Workers (authless)
- Stand up a Streamable HTTP MCP endpoint at `/mcp` on a Worker (stateless JSON). Expose **one** no-op tool (`clio_ping`) that returns a static payload.
- Wrangler project with D1 + KV bindings declared (empty for now).
- **Accept:** `npx @modelcontextprotocol/inspector` connects to the deployed `*.workers.dev/mcp` and calls `clio_ping`.

### M2 — Leg 1 OAuth (Claude ⇄ us), Clio not yet involved
- Implement the AS: protected-resource metadata, AS metadata, `/register` (DCR), `/authorize`, `/token`, PKCE S256. Protect `/mcp` (reject missing/invalid/wrong-audience tokens).
- Use a **dummy upstream user** for now (hardcoded test identity) so you can validate the handshake in isolation.
- **Accept:** MCP Inspector (and a real Claude custom-connector add) completes the OAuth dance and can call `clio_ping` only when authenticated. Unauthenticated `/mcp` returns 401 with correct `WWW-Authenticate`/resource-metadata pointer.

### M3 — Leg 2 OAuth (us ⇄ Clio) + per-user token store
- Implement `/authorize` → Clio `/oauth/authorize` redirect (region from `CLIO_REGION`), `/clio/callback`, code exchange, fetch Clio `user_id`.
- `users` table in D1 (`user_id`, `clio_user_id`, `clio_region`, timestamps). Clio tokens stored as **AES-256-GCM ciphertext** (WebCrypto `SubtleCrypto`, key from `ENCRYPTION_KEY` secret) in KV keyed by `user_id`. **Never** store plaintext tokens; **never** put tokens or secrets in logs or URLs.
- Token refresh: transparent refresh on expiry; persist new refresh token.
- Replace the dummy identity from M2 with the real brokered user. Drop the upstream in-chat `authenticate`/`logout` tools (auth is now connector-level); replace `auth_status` with `clio_whoami` returning the connected Clio user + token expiry.
- **Accept:** two different Clio **users within the firm** can each connect through the same connector URL (each via their own Clio login against the one private app); `clio_whoami` returns the correct distinct identity for each; tokens at rest are ciphertext; expired-token refresh works. Each user's token is region-bound — persist `clio_region` and route per user.

### M4 — Port the Clio tools (multi-tenant)
- Wire the inherited 26 tools through a **thin registration adapter** that (a) prefixes names with `clio_` and (b) injects the **current request's** per-user Clio client. Keep the upstream tool files as close to untouched as possible (see §8).
- Per-user Clio API client: region base URL, explicit `fields` selection (default payload is only `id`+`etag`), pagination (`limit` + follow `meta.paging`, return `has_more`/`next` metadata), and **429 handling** (respect `Retry-After`, bounded exponential backoff).
- Set tool **annotations** accurately (clients surface these before a call): read tools `readOnlyHint:true, openWorldHint:true`; all 9 write tools `readOnlyHint:false, openWorldHint:true, idempotentHint:false` — the additive creates (`create_matter`, `upload_document`, `create_task`, `create_calendar_entry`, `log_time_entry`, `create_activity`, `create_note`) `destructiveHint:false`, the state-mutating `update_task`/`complete_task` `destructiveHint:true`. If `V1_WRITE_SCOPE=read-only`, do not register any of the write tools (and set the Clio app permissions read-only).
- Use Zod input schemas with descriptions; return both text and `structuredContent` where the SDK supports it.
- **Accept:** all read tools return that user's real Clio data; writes (if enabled) create against the correct user's Clio; a tool that hits rate limits recovers; no tool can read another user's data (verified by isolation test in M6).

### M5 — Centralized audit log
- Port the upstream audit format to a D1 `audit_log` table (append-only): `ts, user_id, clio_user_id, tool, args_redacted, outcome, error_message?, result_count?, matter_id?`. Redact secrets/PII per upstream behavior.
- **Audit export is out-of-band only:** a documented SQL/D1 export path the operator runs against D1. Do **not** ship an in-MCP `clio_export_audit` tool — in a per-user OAuth model every connected user holds an identical token shape, so there is no in-band way to distinguish an admin, and such a tool would read across tenants, violating §7's isolation invariant.
- **Accept:** every tool call writes exactly one audit row attributed to the right user; secrets never appear in `args_redacted`.

### M6 — Hardening + deploy + wire Claude org
- **Isolation test (must pass):** authenticated as user A, attempt by any means to reach user B's tokens/data → impossible. Add an automated test.
- Validate token **audience** on every request; enforce redirect-URI allowlist; CSRF/state on both OAuth legs; PKCE mandatory; rate-limit the public endpoints.
- **Firm login allowlist (M8):** restrict who may complete Leg 2 to the firm — check the `who_am_i` identity at `/clio/callback` against `ALLOWED_EMAIL_DOMAINS`/`ALLOWED_CLIO_USER_IDS` **before** storing tokens or minting a Leg-1 token; reject (403) otherwise. **Fail-closed** (no allowlist → no logins). A Clio Manage private app is not firm-bound, so this is what enforces single-firm.
- Secrets only via `wrangler secret put` (`ENCRYPTION_KEY`, `CLIO_CLIENT_ID`, `CLIO_CLIENT_SECRET`, `COOKIE_ENCRYPTION_KEY`). Nothing sensitive in the repo. Document key-rotation.
- Register **one private** Clio developer app against the firm's own Clio account (no public review / App Directory listing); set its redirect URI to `https://WORKER_HOSTNAME/clio/callback` and its access permissions to match `V1_WRITE_SCOPE`.
- Deploy to `WORKER_HOSTNAME`. Org Owner adds the connector: **Organization settings → Connectors → Add →** `https://WORKER_HOSTNAME/mcp`. Each user connects and OAuths their own Clio.
- **Accept:** end-to-end from a real Claude Team org: admin adds once, two users connect independently, each sees only their own Clio, audit attributes correctly.

### M7 — Evals + docs + upstream-sync runbook
- Create 10 **read-only, independent, verifiable** eval questions (firm-specific data; provide as a template the operator fills, since answers depend on the firm's Clio). Format per the XML schema in §9.
- Write `docs/operations.md`: deploy, rotate keys, add/remove the connector, read the audit log, and the **upstream sync runbook** (§8).
- **Accept:** docs complete; `git fetch upstream && git merge upstream/main` performed once as a dry run with conflicts (if any) resolved and recorded in `CHANGELOG.local.md`.

---

## 6. Endpoint contract (summary)

| Path | Purpose |
|---|---|
| `GET /.well-known/oauth-protected-resource` | RFC 9728 metadata pointing to our AS |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 AS metadata |
| `POST /register` | Dynamic Client Registration (RFC 7591) |
| `GET /authorize` | Leg 1 start → creates session → redirects to Clio (Leg 2 start) |
| `GET /clio/callback` | Leg 2 return; exchange Clio code; store tokens; complete Leg 1 |
| `POST /token` | Leg 1 token issuance/refresh |
| `POST /mcp` | Streamable HTTP MCP endpoint (auth-protected) |

---

## 7. Security requirements (non-negotiable)

- **Per-user isolation is the top invariant.** Token lookup is keyed strictly by the authenticated `user_id`. No code path may select another user's tokens. Cover with an automated test.
- Encryption at rest: AES-256-GCM, key from secret, ciphertext only. No plaintext tokens anywhere, including logs and error messages.
- Validate **audience** on our access tokens; reject tokens not minted for this resource.
- PKCE S256 mandatory on Leg 1; `state` + CSRF protection on both legs; strict redirect-URI allowlist.
- Never place tokens, secrets, or PII in URLs, query strings, or the audit `args`.
- **Write-surface risk is intra-user, not cross-user.** Per-user isolation stops a user writing to anyone else's Clio, but with `V1_WRITE_SCOPE=all` the model can still issue an unintended write (wrong matter, spurious time entry) against the user's *own* Clio. This is accepted by design (users gate per-tool in Claude Desktop), but don't represent writes as confirmation-free: keep write annotations accurate (§M4) so the client can prompt, advise users at rollout that per-tool toggles are opt-out, lean on Clio's own per-user permissions as the backstop, and treat `V1_WRITE_SCOPE=read-only` as the documented kill-switch.
- Don't leak internal errors to the client; log server-side, return actionable but non-revealing messages.
- Data-flow note for the firm's records: results reach Anthropic's models for inference in all designs (Team/Enterprise = no training on your data); self-hosting adds **no third-party processor** beyond Anthropic, unlike a gateway. State this in `docs/operations.md`.

---

## 8. Upstream-merge discipline (this is a primary requirement, not a nicety)

The whole reason to fork is to keep pulling Clio fixes from `oktopeak/clio-mcp`. Structure the repo so `git merge upstream/main` rarely conflicts:

- **All new concerns go in new directories**, leaving upstream files alone:
  - `src/remote/` — Streamable HTTP entry, Worker handler, routing.
  - `src/auth/` — AS (Leg 1) + Clio broker (Leg 2).
  - `src/storage/` — D1/KV, encryption, token store.
  - `src/audit/` — centralized audit sink.
  - `src/adapter/` — the registration adapter that prefixes tools `clio_` and injects the per-user client.
- **Touch upstream tool files as little as possible.** Prefer wrapping over editing. If you must change a tool (e.g., to accept an injected client instead of a module-global token), make the **smallest possible diff** and log it in `CHANGELOG.local.md` with the rationale, so a future merge is easy to reason about.
- Keep the upstream **stdio/local entrypoint working** (don't delete it). Your remote shell is additive. This keeps diffs against upstream minimal and gives a local fallback.
- Pin a `git tag upstream-sync/<date>` after each successful merge; record the upstream commit SHA in `CHANGELOG.local.md`.
- Sync cadence: documented in `docs/operations.md` (suggest: check upstream on a schedule; merge, build, run isolation + smoke tests, redeploy).

---

## 9. Evaluation format (M7)

```xml
<evaluation>
  <qa_pair>
    <question>For matter &lt;display_number&gt;, how many Pending tasks are due before &lt;date&gt;?</question>
    <answer>FIRM-SPECIFIC — operator fills after pointing at a known matter</answer>
  </qa_pair>
  <!-- 10 total; each independent, read-only, single verifiable answer, stable over time -->
</evaluation>
```

Each question: independent, read-only, requires multiple tool calls, realistic for a firm, single string-verifiable answer. Because answers depend on the firm's live Clio data, deliver the 10 questions as a template the operator finalizes against a test matter set.

---

## 10. Known Clio quirks to handle (verify against current docs)

- **`fields` is effectively required** (but not enforced — omitting it returns only `id`+`etag`, it does not error). Each tool must request the fields it needs. Nested-association selection is supported (e.g. `matter{id,display_number}`); the exact depth limit is unsettled (sources differ on one vs two levels, second level returns defaults only) — verify against the live `fields` doc. No wildcard syntax exists.
- **Regional base/OAuth URLs** differ by `CLIO_REGION` — API bases: US `app.clio.com`, EU `eu.app.clio.com`, CA `ca.app.clio.com`, AU `au.app.clio.com` (all `/api/v4`). **Tokens are region-bound** (a US token is invalid against other regions): store each user's region and route OAuth **and** API calls to the matching host. **OAuth lives on the same regional host** — for our EU firm: `https://eu.app.clio.com/oauth/{authorize,token}`. Do **not** use `auth.api.clio.com` — that host is the separate *Clio Platform* product, not Clio Manage v4. Drive everything off one region config.
- **Scopes are app-level, not per-request.** Clio has no `scope` parameter in the OAuth flow; read-only vs read/write is set per-category on the app in the Developer Portal and **locked at authorization** (changing it forces all users to re-authorize). So `V1_WRITE_SCOPE` is an app-registration decision, app-wide.
- **Rate limiting** is **per access token** (multi-tenant-friendly — each user has their own bucket, ~50 req/min peak): respect `429` + `Retry-After` with bounded backoff (upstream already does this), optionally throttle on `X-RateLimit-Remaining`/`Reset`; surface a clear actionable error if exhausted.
- **Identity**: map a token to a user via `GET /api/v4/users/who_am_i?fields=id,name,email`. Access tokens last 30 days (`expires_in: 2592000`); refresh tokens don't expire and are non-rotating (the refresh response returns no new `refresh_token`).
- **Pagination**: follow `meta.paging` next links; respect `limit`; return `has_more`/`next` metadata. Never load all pages blindly into memory.
- Carry over any flat-fee / billing-method quirks documented upstream if you touch billing tools.

---

## 11. Definition of done

- Org Owner adds **one** URL; multiple attorneys each connect with their **own** Clio and see only their own data.
- Tokens encrypted at rest; per-user isolation test passes; audit log attributes every call correctly.
- Pagination + 429 handled; tools annotated; read/write scope matches `V1_WRITE_SCOPE`.
- `git merge upstream/main` completes with minimal, documented conflicts.
- `docs/operations.md` (deploy, rotate, audit, upstream-sync) + 10 eval questions delivered.
