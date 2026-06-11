import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { version as SERVER_VERSION } from "../../../package.json";

const SERVER_NAME = "clio-mcp";

export const PING_PAYLOAD = {
  ok: true,
  service: "clio-oauth-mcp",
  milestone: "M1",
  transport: "streamable-http",
  note: "Authless no-op. OAuth (M2) and Clio tools (M4) are not wired yet.",
} as const;

// Stateless: a fresh server is built per request (see worker.ts). The remote shell adds
// no tools beyond clio_ping until M4 ports the upstream Clio tools through the adapter.
export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "clio_ping",
    {
      title: "Clio ping",
      description:
        "No-op liveness check for the Clio remote MCP connector. Returns a static payload; touches no Clio data.",
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    async () => ({
      content: [{ type: "text", text: JSON.stringify(PING_PAYLOAD) }],
    }),
  );

  return server;
}
