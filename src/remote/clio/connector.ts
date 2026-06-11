/**
 * Env-bound glue between the Worker bindings and the pure Clio client / token store. Keeps the
 * Workers-typed `Env` out of the testable pieces (oauth.ts, tokenStore.ts stay env-free).
 *
 * `getUserClioToken` is the single seam for "act as this user against Clio": it resolves and
 * transparently refreshes the user's token from D1. M3's clio_whoami uses it; M4's per-user tool
 * injection (the AsyncLocalStorage adapter) will use the same function.
 */

import type { Env } from "../env.js";
import { type ClioOAuthConfig, refreshClioTokens } from "./oauth.js";
import { d1TokenRepo, getValidClioToken } from "../storage/tokenStore.js";
import { kvCachedTokenRepo } from "../storage/kvTokenRepo.js";

/** Build the Clio OAuth config from env, failing loudly if the connector secrets are unset. */
export function clioConfigFromEnv(env: Env): ClioOAuthConfig {
  if (!env.CLIO_CLIENT_ID || !env.CLIO_CLIENT_SECRET) {
    throw new Error("Clio connector not configured: set CLIO_CLIENT_ID and CLIO_CLIENT_SECRET");
  }
  return { region: env.CLIO_REGION, clientId: env.CLIO_CLIENT_ID, clientSecret: env.CLIO_CLIENT_SECRET };
}

export function requireEncryptionKey(env: Env): string {
  if (!env.ENCRYPTION_KEY) {
    throw new Error("Clio connector not configured: set ENCRYPTION_KEY");
  }
  return env.ENCRYPTION_KEY;
}

/**
 * Resolve a valid Clio access token for a user (refreshing + persisting if near expiry). Refresh
 * uses the user's *stored* region (tokens are region-bound), not necessarily env's default.
 */
export function getUserClioToken(env: Env, userId: string): Promise<{ accessToken: string; region: string; expiresAt: number }> {
  const cfg = clioConfigFromEnv(env);
  // M4 hot path: every tool call resolves the token, so cache the D1 read in KV (cache only — D1
  // stays authoritative; the cache holds ciphertext, and writes invalidate it). See kvTokenRepo.ts.
  const repo = kvCachedTokenRepo(env.CLIO_TOKENS, d1TokenRepo(env.DB));
  return getValidClioToken(
    repo,
    requireEncryptionKey(env),
    (region, refreshToken) => refreshClioTokens({ ...cfg, region }, refreshToken),
    userId,
  );
}
