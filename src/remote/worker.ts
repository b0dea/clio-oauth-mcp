/**
 * Remote MCP Worker entry — Clio multi-tenant connector.
 *
 * Additive remote shell (PRD §8): everything new lives under src/remote/ and never edits
 * upstream tool files. The Worker is wrapped in workers-oauth-provider, making it an OAuth
 * 2.1 Authorization Server + Resource Server for /mcp (M2, Leg 1 — Claude <-> us).
 *
 * The provider OWNS /token, /register, and the RFC 8414 / RFC 9728 metadata endpoints, and
 * gates /mcp: it rejects missing/invalid/expired/wrong-audience bearer tokens with 401 +
 * WWW-Authenticate(resource_metadata=...) and only then dispatches to the apiHandler with the
 * decrypted grant props on ctx. Audience binds automatically from the client's RFC 8707
 * `resource` param (the canonical /mcp URL the user types in Claude); the path-aware PRM
 * endpoint derives that resource from the request, so nothing host-specific is hardcoded.
 *
 *   apiRoute ["/mcp"]  -> api (Hono)            — authenticated MCP turn, props injected
 *   defaultHandler     -> defaultHandler (Hono) — /authorize consent, /health, /clio/callback
 *
 * Clio is NOT involved yet: /authorize approves a hardcoded dummy identity. M3 swaps the
 * default handler for the Clio broker (Leg 2). Serving stack unchanged from M1: Hono +
 * @hono/mcp StreamableHTTPTransport, stateless JSON (docs/build-notes.md §2).
 */

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";

import { api } from "./mcp/api.js";
import { defaultHandler } from "./auth/default-handler.js";
import type { Env } from "./env.js";

export type { Env };

export default new OAuthProvider<Env>({
  apiRoute: ["/mcp"],
  // Object (ExportedHandler) form: the provider sets ctx.props on the same ExecutionContext
  // it passes here, and Hono surfaces it as c.executionCtx.props — so the plain bound-fetch
  // form delivers props; no WorkerEntrypoint needed (build-notes §10 spike #1, resolved).
  apiHandler: { fetch: api.fetch.bind(api) },
  defaultHandler: { fetch: defaultHandler.fetch.bind(defaultHandler) },
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  // OAuth 2.1: S256 only, no plain PKCE.
  allowPlainPKCE: false,
});
