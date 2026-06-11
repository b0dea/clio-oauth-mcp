/**
 * Builds the minimal upstream SessionContext that the /mcp handler runs each MCP turn inside
 * (sessionStorage.run, see src/remote/mcp/api.ts). clioClient.ts's resolveAccessToken() reads this
 * context, so every one of the 22 ported tools resolves THIS request's user token — per-user
 * injection with zero tool edits.
 *
 * Only getAccessToken() is real. The other members (storeTokens/getTokens/clearTokens/
 * setPendingNonce) belong to the dropped stdio auth tools; no ported data tool calls them, so they
 * throw loudly rather than silently no-op — a call would mean something on the Worker is wrongly
 * reaching for the single-user disk token flow.
 */

import type { SessionContext } from "../../utils/sessionContext.js";
import type { ClioTokens } from "../../auth/oauth.js";

function unsupported(member: string): never {
  throw new Error(
    `SessionContext.${member} is not available in the multi-tenant Worker; per-user Clio tokens ` +
      `live in the encrypted store and are read via getAccessToken()`,
  );
}

export function buildClioSessionContext(userId: string, resolveAccessToken: () => Promise<string>): SessionContext {
  // Resolve once per request — paginated/multi-step tool calls share one token lookup. A failure is
  // not memoized: clear it so a transient D1/KV/refresh error doesn't poison the rest of the turn.
  let token: Promise<string> | undefined;
  return {
    sessionId: userId,
    getAccessToken: () => (token ??= resolveAccessToken().catch((err) => {
      token = undefined;
      throw err;
    })),
    storeTokens: (_tokens: ClioTokens) => unsupported("storeTokens"),
    getTokens: () => unsupported("getTokens"),
    clearTokens: () => unsupported("clearTokens"),
    setPendingNonce: (_nonce: string) => unsupported("setPendingNonce"),
  };
}
