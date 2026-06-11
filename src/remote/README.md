# `src/remote/` — the remote multi-tenant shell

Everything in this directory is **additive**. It turns the upstream stdio Clio MCP server
into a remote, multi-user Cloudflare Worker **without editing upstream tool files**, so
`git merge upstream/main` stays clean (PRD §8). Read `docs/build-notes.md` first — it has the
verified APIs, versions, and the upstream port map.

## Start here

Both OAuth legs are live and the Clio tools are ported, multi-tenant — **M4 done**. Leg 1 (Claude ⇄ us) is
`new OAuthProvider({...})` (DCR, PKCE-S256, `/authorize`, `/token`, `/.well-known/*`); Leg 2 (us ⇄ Clio) is
the Clio broker (`auth/clio-handler.ts`): `/authorize` → Clio, `/clio/callback` exchanges the code, reads
`who_am_i`, encrypts the per-user tokens into D1 (`storage/`), and mints the Leg-1 token bound to the real
Clio user. **M4:** `adapter/clioTools.ts` registers 21 upstream Clio tools `clio_`-prefixed + annotated, and
`mcp/api.ts` runs each MCP turn inside `sessionStorage.run(ctx)` so every tool resolves THIS user's token via
the upstream `AsyncLocalStorage` seam (`adapter/sessionContext.ts` + `getUserClioToken`). Node-hostile upstream
deps (keyring/fs) are swapped for `upstream-shims/` via the wrangler `alias` map. Live tool calls stop at
Clio's door until a real Clio app's `CLIO_CLIENT_ID`/`SECRET` are set (placeholders for now). Next task is
**M5**: the centralized append-only D1 audit log (`upstream-shims/auditLog.ts` is a no-op until then).

```bash
npm install
npm run typecheck:worker     # type-check src/remote
npx wrangler deploy --dry-run --outdir /tmp/wbuild   # verify it bundles, no upload
npx wrangler deploy          # deploy to *.workers.dev (needs the D1/KV ids in wrangler.jsonc)
npx wrangler dev             # local dev
npx @modelcontextprotocol/inspector   # point at https://<worker>.workers.dev/mcp
```

Secrets (set once per environment, never commit):

```bash
wrangler secret put ENCRYPTION_KEY          # 32-byte key, base64; for AES-256-GCM at rest
wrangler secret put CLIO_CLIENT_ID
wrangler secret put CLIO_CLIENT_SECRET
wrangler secret put COOKIE_ENCRYPTION_KEY   # signs the consent cookie
# Local dev: put the same keys in .dev.vars (gitignored)
```

## Milestone → where the code goes (all new dirs under `src/remote/`)

| Milestone | What | Add under |
|---|---|---|
| M1 | `/mcp` Streamable HTTP + `clio_ping` (Hono + `@hono/mcp` `StreamableHTTPTransport`, stateless, `enableJsonResponse`) | `worker.ts` |
| M2 | Leg 1 OAuth AS — wrap the Worker in `new OAuthProvider({...})` (DCR, /authorize, /token, PKCE, metadata) | `worker.ts` + `auth/` |
| M3 | Leg 2 — Clio OAuth client (`/authorize`→Clio, `/clio/callback`, code exchange, `who_am_i`) | `auth/clio-handler.ts` |
| M3 | Per-user encrypted token store (AES-256-GCM via SubtleCrypto; D1 primary, KV cache) | `storage/` |
| M4 | Registration adapter — prefix tools `clio_`, inject the per-user Clio client via the upstream `AsyncLocalStorage` seam | `adapter/` |
| M5 | Centralized audit log → D1 `audit_log` (append-only) | `audit/` |

## The injection seam (no tool edits)

Upstream resolves the Clio token through `resolveAccessToken()` (in `src/utils/clioClient.ts`),
which reads an `AsyncLocalStorage<SessionContext>` (`src/utils/sessionContext.ts`). To make a tool
call act as a given user, build a `SessionContext` whose `getAccessToken()` returns that user's
decrypted Clio token (from `storage/`), then run the MCP request inside `sessionStorage.run(ctx, ...)`.
**Always populate the context** — the stdio fallback (`getValidAccessToken()` → disk / browser OAuth)
must never fire on Workers. Prefix tool names by wrapping `McpServer.registerTool` (~10 lines), do not
edit the 26 tool files.

## End-state entry shape (M2+)

Serving stack: **`@hono/mcp` on the MCP SDK's fetch-native WebStandard transport, behind
`@cloudflare/workers-oauth-provider`.** No `agents` SDK (it forces zod 4 — see `docs/build-notes.md` §2).

```ts
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { StreamableHTTPTransport } from "@hono/mcp";        // fetch-native, wraps the SDK WebStandard transport
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sessionStorage } from "../utils/sessionContext.js"; // upstream AsyncLocalStorage seam

const api = new Hono<{ Bindings: Env }>();
api.all("/mcp", async (c) => {
  // workers-oauth-provider already validated the bearer token; the granted props are on ctx.props.
  const { clioAccessToken } = c.executionCtx.props as { clioAccessToken: string };
  // Run the whole MCP turn inside upstream's ALS so every one of the 26 tools resolves THIS user's token.
  return sessionStorage.run(buildSessionContext(clioAccessToken), async () => {
    const server = new McpServer({ name: "clio-mcp", version }); // fresh per request (SDK >=1.26)
    registerClioTools(server);                                   // upstream tools, clio_-prefixed by the adapter
    const transport = new StreamableHTTPTransport({ enableJsonResponse: true }); // stateless: no sessionIdGenerator
    await server.connect(transport);
    return transport.handleRequest(c);                           // takes the Hono Context, returns a Response
  });
});

export default new OAuthProvider({
  apiRoute: ["/mcp"],
  apiHandler: { fetch: api.fetch.bind(api) },  // ctx.props delivered as c.executionCtx.props (confirmed M2 — no WorkerEntrypoint needed)
  defaultHandler: ClioHandler,                 // Leg 2: /authorize→Clio, /clio/callback, completeAuthorization({ props })
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
```

Gotcha from research: the Cloudflare GitHub OAuth template parses the upstream token response with
`resp.formData()`; **Clio returns JSON → use `resp.json()`**.

## Merge-safety rules

- New concerns → new files under `src/remote/`. Never edit `src/tools/**`.
- If you must touch an upstream file, make the smallest possible diff and log it in
  `CHANGELOG.local.md` with the rationale.
- The stdio entrypoint (`src/index.ts`) and `npm run build` must keep working — they're the
  local fallback and the thing that proves merges didn't break upstream.
