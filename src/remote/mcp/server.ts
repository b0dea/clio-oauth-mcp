import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { version as SERVER_VERSION } from "../../../package.json";

const SERVER_NAME = "clio-mcp";

export const PING_PAYLOAD = {
  ok: true,
  service: "clio-oauth-mcp",
  transport: "streamable-http",
  note: "Authenticated no-op. Touches no Clio data; the Clio tools land in M4.",
} as const;

// The authenticated identity the api handler injects per request, decrypted from the
// access-token grant props by workers-oauth-provider. M4 widens this with the per-user
// Clio client; for now clio_ping just echoes the user id to prove the props seam works.
export interface AuthContext {
  userId: string;
}

// Stateless: a fresh server is built per request (see worker.ts). The remote shell adds
// no tools beyond clio_ping until M4 ports the upstream Clio tools through the adapter.
export function buildMcpServer(auth?: AuthContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "clio_ping",
    {
      title: "Clio ping",
      description:
        "No-op liveness check for the Clio remote MCP connector. Returns a static payload plus the authenticated user id; touches no Clio data.",
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({ ...PING_PAYLOAD, authenticatedUser: auth?.userId ?? null }),
        },
      ],
    }),
  );

  return server;
}
