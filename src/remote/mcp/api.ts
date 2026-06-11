/**
 * The OAuthProvider `apiHandler` (apiRoute ["/mcp"]). The provider only routes here after
 * it has validated the bearer token — present, unexpired, and audience-bound to this exact
 * /mcp URL (RFC 8707). It decrypts the grant props onto the execution ctx; we read them off
 * `c.executionCtx.props` and inject the identity into the per-request MCP server. M4 swaps
 * the echoed identity for the per-user Clio client via this same seam.
 */

import { Hono } from "hono";
import { StreamableHTTPTransport } from "@hono/mcp";

import { buildMcpServer } from "./server.js";
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

  const server = buildMcpServer({ userId: props.userId });
  const transport = new StreamableHTTPTransport({ enableJsonResponse: true });
  await server.connect(transport);
  return (await transport.handleRequest(c)) ?? c.text("MCP transport produced no response", 500);
});

api.onError((err, c) => {
  console.error("api handler error:", err);
  return c.json({ error: "server_error" }, 500);
});
