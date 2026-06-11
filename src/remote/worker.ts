/**
 * Remote MCP Worker entry — Clio multi-tenant connector.
 *
 * Additive remote shell (PRD §8): everything new lives under src/remote/ and never
 * edits upstream tool files. This skeleton serves a health check and returns 501 for
 * the not-yet-built OAuth + MCP routes, so the toolchain (wrangler deploy → MCP
 * Inspector) works end-to-end before any milestone is implemented.
 *
 * Build it out per docs/build-notes.md and the milestone map in src/remote/README.md.
 * The end state replaces this default export with `new OAuthProvider({...})` wrapping a
 * stateless `createMcpHandler` — see src/remote/README.md.
 */

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

const notImplemented = (milestone: string): Response =>
  Response.json({ error: "not_implemented", milestone }, { status: 501 });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/" || pathname === "/health") {
      return Response.json({
        service: "clio-oauth-mcp",
        status: "ok",
        region: env.CLIO_REGION ?? "unset",
        note: "Skeleton — OAuth + /mcp routes not yet implemented. See src/remote/README.md.",
      });
    }

    switch (pathname) {
      case "/.well-known/oauth-protected-resource":
      case "/.well-known/oauth-authorization-server":
      case "/register":
      case "/authorize":
      case "/token":
        return notImplemented("M2 — Leg 1 OAuth (workers-oauth-provider)");
      case "/clio/callback":
        return notImplemented("M3 — Leg 2 OAuth (Clio broker)");
      case "/mcp":
        return notImplemented("M1/M4 — Streamable HTTP MCP endpoint");
      default:
        return new Response("Not found", { status: 404 });
    }
  },
};
