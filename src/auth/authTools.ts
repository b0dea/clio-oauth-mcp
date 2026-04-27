import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { clearTokens, loadTokens } from "./tokenStorage.js";
import { getValidAccessToken } from "./oauth.js";
import { appendAuditLog } from "../utils/auditLog.js";

export function registerAuthTools(server: McpServer): void {
  server.registerTool(
    "auth_status",
    { description: "Check whether the connector is authenticated with Clio and when the token expires" },
    async () => {
      const tokens = await loadTokens();

      await appendAuditLog({
        tool: "auth_status",
        args: {},
        outcome: "success",
        clio_user_id: tokens?.clio_user_id,
      });

      if (!tokens) {
        return {
          content: [{ type: "text", text: JSON.stringify({ authenticated: false }) }],
        };
      }

      const expiresIn = Math.floor((tokens.expires_at - Date.now()) / 1000 / 60);
      const token_expired = expiresIn < 0;
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            authenticated: true,
            clio_user_id: tokens.clio_user_id
              ?? (tokens.user_id_unavailable
                ? "unavailable — Clio app lacks user-profile permission (HTTP 403 on who_am_i)"
                : "unknown"),
            token_expires_in_minutes: expiresIn,
            token_expired,
            ...(token_expired && { warning: "Token has expired. Run the 'authenticate' tool to refresh." }),
          }),
        }],
      };
    }
  );

  server.registerTool(
    "authenticate",
    { description: "Trigger the Clio OAuth login flow" },
    async () => {
      try {
        await getValidAccessToken();
        await appendAuditLog({ tool: "authenticate", args: {}, outcome: "success" });
        return {
          content: [{ type: "text", text: "✅ Successfully authenticated with Clio!" }],
        };
      } catch (err: any) {
        await appendAuditLog({ tool: "authenticate", args: {}, outcome: "error", error_message: err.message });
        return {
          content: [{ type: "text", text: `❌ Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "logout",
    { description: "Log out of Clio (clears local tokens)" },
    async () => {
      try {
        const tokens = await loadTokens();
        const clio_user_id = tokens?.clio_user_id;
        await clearTokens();
        await appendAuditLog({ tool: "logout", args: {}, outcome: "success", clio_user_id });
        return {
          content: [{ type: "text", text: "✅ Logged out. Tokens cleared." }],
        };
      } catch (err: any) {
        await appendAuditLog({ tool: "logout", args: {}, outcome: "error", error_message: err.message });
        return {
          content: [{ type: "text", text: `❌ Logout failed: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
