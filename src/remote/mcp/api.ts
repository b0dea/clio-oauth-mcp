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

  const server = buildMcpServer(deps);
  const transport = new StreamableHTTPTransport({ enableJsonResponse: true });
  await server.connect(transport);
  return (await transport.handleRequest(c)) ?? c.text("MCP transport produced no response", 500);
});

api.onError((err, c) => {
  console.error("api handler error:", err);
  return c.json({ error: "server_error" }, 500);
});
