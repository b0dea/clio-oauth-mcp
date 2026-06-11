/**
 * The OAuthProvider `apiHandler` (apiRoute ["/mcp"]). The provider only routes here after
 * validating the bearer token — present, unexpired, and audience-bound to this exact /mcp URL
 * (RFC 8707). It decrypts the grant props onto the execution ctx; we read them off
 * `c.executionCtx.props` and inject per-request capabilities into the MCP server: the identity
 * (echoed by clio_ping) and a `whoami` closure that resolves the user's Clio token and live
 * identity. M4 injects the per-user Clio client for the upstream tools through this same seam.
 */

import { Hono } from "hono";
import { StreamableHTTPTransport } from "@hono/mcp";

import { buildMcpServer, type McpDeps } from "./server.js";
import { getUserClioToken } from "../clio/connector.js";
import { fetchClioIdentity } from "../clio/oauth.js";
import { buildClioSessionContext } from "../adapter/sessionContext.js";
import { sessionStorage } from "../../utils/sessionContext.js";
import type { Env, ConnectorProps } from "../env.js";

export const api = new Hono<{ Bindings: Env }>();

// Stateless Streamable HTTP: fresh server + transport per request, enableJsonResponse so a
// single POST returns a JSON-RPC response rather than an SSE stream (see worker.ts / M1).
api.all("/mcp", async (c) => {
  const props = (c.executionCtx as ExecutionContext & { props?: ConnectorProps }).props;
  if (!props?.userId) {
    // Unreachable: the provider only dispatches authenticated requests to the api handler.
    // Fail loud rather than silently serve an unauthenticated session.
    console.error("/mcp reached the api handler without authenticated props");
    return c.json({ error: "server_error" }, 500);
  }

  const env = c.env;
  const userId = props.userId;
  const deps: McpDeps = {
    auth: { userId, clioUserId: props.clioUserId },
    whoami: async () => {
      const { accessToken, region, expiresAt } = await getUserClioToken(env, userId);
      const id = await fetchClioIdentity(region, accessToken);
      return {
        clioUserId: id.id,
        name: id.name,
        email: id.email,
        tokenExpiresInMinutes: Math.floor((expiresAt - Date.now()) / 60000),
      };
    },
  };

  // Run the whole MCP turn inside upstream's AsyncLocalStorage so every ported tool's
  // resolveAccessToken() resolves THIS user's Clio token (clioClient.ts reads this context). The
  // context is always populated, so the stdio disk/browser fallback never fires on the Worker.
  // Only the token is injected, not the region: clioClient.ts getBase() routes off
  // process.env.CLIO_REGION (the EU worker var), so all users hit eu.app.clio.com — correct for the
  // single-region pilot. Per-user routing off the stored clioRegion is deferred (would need the
  // do-not-edit clioClient to read the region from this context).
  const ctx = buildClioSessionContext(userId, async () => (await getUserClioToken(env, userId)).accessToken);
  return sessionStorage.run(ctx, async () => {
    const server = buildMcpServer(deps);
    const transport = new StreamableHTTPTransport({ enableJsonResponse: true });
    await server.connect(transport);
    return (await transport.handleRequest(c)) ?? c.text("MCP transport produced no response", 500);
  });
});

api.onError((err, c) => {
  console.error("api handler error:", err);
  return c.json({ error: "server_error" }, 500);
});
