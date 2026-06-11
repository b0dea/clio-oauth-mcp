/**
 * Worker replacement for the upstream stdio token store (src/auth/tokenStorage.ts), swapped in by
 * the wrangler `alias` map for the Worker build only (the stdio build keeps the real module).
 *
 * The original uses the OS keychain (@napi-rs/keyring — a native addon that cannot be bundled for
 * Workers) and the filesystem, and computes `os.homedir()` at module load. On the multi-tenant
 * Worker none of that applies: each user's Clio tokens live in the encrypted D1 store
 * (src/remote/storage) and are injected per request through the AsyncLocalStorage SessionContext
 * (src/remote/mcp/api.ts). resolveAccessToken() in clioClient.ts uses that context and only falls
 * back to this disk store when no context is set — which never happens on the Worker.
 *
 * So these functions are unreachable here; they throw loudly rather than silently touch disk, so a
 * missing SessionContext surfaces as a clear error instead of a confusing keychain/fs failure.
 */

import type { ClioTokens } from "../../auth/oauth.js";

const STDIO_ONLY =
  "tokenStorage is stdio-only; the multi-tenant Worker injects per-user Clio tokens via the " +
  "SessionContext (a populated context makes resolveAccessToken bypass this disk store)";

export async function saveTokens(_tokens: ClioTokens): Promise<void> {
  throw new Error(STDIO_ONLY);
}

export async function loadTokens(): Promise<ClioTokens | null> {
  throw new Error(STDIO_ONLY);
}

export async function clearTokens(): Promise<void> {
  throw new Error(STDIO_ONLY);
}
