/**
 * Remote MCP Worker entry — Clio multi-tenant connector.
 *
 * Additive remote shell (PRD §8): everything new lives under src/remote/ and never
 * edits upstream tool files. M1 serves a real Streamable HTTP MCP endpoint at /mcp with
 * one no-op tool (clio_ping); OAuth (M2) and the Clio broker (M3) routes still return 501.
 *
 * Serving stack (decided — docs/build-notes.md §2): Hono + @hono/mcp's
 * StreamableHTTPTransport over the MCP SDK's fetch-native WebStandard transport. Stateless
 * JSON: a fresh McpServer + transport per request, no sessionIdGenerator, enableJsonResponse.
 * M2 wraps this app in `new OAuthProvider({...})` — see src/remote/README.md.
 */

import { Hono, type Context } from "hono";
import { StreamableHTTPTransport } from "@hono/mcp";

import { buildMcpServer } from "./mcp/server.js";

export interface Env {
  // Bindings (declared in wrangler.jsonc)
  OAUTH_KV: KVNamespace; // workers-oauth-provider token/client store
  CLIO_TOKENS: KVNamespace; // per-user encrypted Clio-token cache (D1 is the primary)
  DB: D1Database; // users + audit (+ primary token rows)
  // Vars
  CLIO_REGION: string; // EU for the pilot — drives all Clio base + OAuth URLs
  // Secrets (set via `wrangler secret put`): ENCRYPTION_KEY, CLIO_CLIENT_ID,
  // CLIO_CLIENT_SECRET, COOKIE_ENCRYPTION_KEY. Optional here so the skeleton type-checks.
  ENCRYPTION_KEY?: string;
  CLIO_CLIENT_ID?: string;
  CLIO_CLIENT_SECRET?: string;
  COOKIE_ENCRYPTION_KEY?: string;
}

const app = new Hono<{ Bindings: Env }>();

app.on(["GET", "HEAD"], ["/", "/health"], (c) =>
  c.json({
    service: "clio-oauth-mcp",
    status: "ok",
    region: c.env.CLIO_REGION ?? "unset",
    note: "M1 — /mcp live (authless). OAuth + Clio routes not yet implemented. See src/remote/README.md.",
  }),
);

// Streamable HTTP MCP endpoint. Stateless: fresh server + transport per request, so
// there is no cross-request session state to lose on a Worker cold start or eviction.
// enableJsonResponse → a single POST returns a JSON-RPC response instead of an SSE stream.
// @hono/mcp's transport defaults to a lenient Accept check (strictAcceptHeader: false), so a
// JSON-only `Accept: application/json` is honored, not 406'd (SDK #1944).
app.all("/mcp", async (c) => {
  const server = buildMcpServer();
  const transport = new StreamableHTTPTransport({ enableJsonResponse: true });
  await server.connect(transport);
  return (await transport.handleRequest(c)) ?? c.text("MCP transport produced no response", 500);
});

// Not-yet-built routes return 501 so the toolchain works end-to-end before each milestone.
const notImplemented = (milestone: string) => (c: Context) =>
  c.json({ error: "not_implemented", milestone }, 501);

const leg1 = notImplemented("M2 — Leg 1 OAuth (workers-oauth-provider)");
app.all("/.well-known/oauth-protected-resource", leg1);
app.all("/.well-known/oauth-authorization-server", leg1);
app.all("/register", leg1);
app.all("/authorize", leg1);
app.all("/token", leg1);
app.all("/clio/callback", notImplemented("M3 — Leg 2 OAuth (Clio broker)"));

app.notFound((c) => c.text("Not found", 404));

export default app;
