import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { version as SERVER_VERSION } from "../../../package.json";
import { registerClioDataTools } from "../adapter/clioTools.js";

const SERVER_NAME = "clio-mcp";

export const PING_PAYLOAD = {
  ok: true,
  service: "clio-oauth-mcp",
  transport: "streamable-http",
  note: "Authenticated no-op. Touches no Clio data; the Clio tools land in M4.",
} as const;

// The authenticated identity the api handler injects per request, decrypted from the
// access-token grant props by workers-oauth-provider.
export interface AuthContext {
  userId: string;
  clioUserId?: string;
}

export interface WhoamiResult {
  clioUserId: string;
  name?: string;
  email?: string;
  tokenExpiresInMinutes: number;
}

/**
 * Per-request capabilities the api handler injects. `whoami` resolves the current user's Clio
 * token (refreshing if needed) and reads their live identity — keeping server.ts free of the
 * storage/env wiring and trivially testable.
 */
export interface McpDeps {
  auth: AuthContext;
  whoami(): Promise<WhoamiResult>;
  /** When false (default), only read tools are registered — the write tools are not advertised. */
  writeEnabled?: boolean;
}

// Stateless: a fresh server is built per request (see mcp/api.ts). The remote shell adds
// clio_ping (liveness) and clio_whoami (connected-identity); the clio_-prefixed Clio data tools
// resolve the caller's token through the per-request SessionContext the api handler installs. Reads
// always register; writes only when deps.writeEnabled (CLIO_WRITE_SCOPE=all) — default read-only.
export function buildMcpServer(deps?: McpDeps): McpServer {
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
        { type: "text", text: JSON.stringify({ ...PING_PAYLOAD, authenticatedUser: deps?.auth.userId ?? null }) },
      ],
    }),
  );

  server.registerTool(
    "clio_whoami",
    {
      title: "Clio whoami",
      description:
        "Return the Clio user this connection is authenticated as, and how long the Clio access token remains valid. Reads only the caller's own Clio identity.",
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    },
    async () => {
      if (!deps) {
        return { content: [{ type: "text", text: "Not connected to Clio." }], isError: true };
      }
      const me = await deps.whoami();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              clio_user_id: me.clioUserId,
              name: me.name,
              email: me.email,
              token_expires_in_minutes: me.tokenExpiresInMinutes,
            }),
          },
        ],
      };
    },
  );

  registerClioDataTools(server, deps?.writeEnabled ?? false);

  return server;
}
