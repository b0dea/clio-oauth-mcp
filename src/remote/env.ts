import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { RateLimiter } from "./rateLimit.js";

/**
 * Worker bindings (declared in wrangler.jsonc) plus the OAuthProvider-injected helper.
 * Kept in its own module so both the api handler and the default handler can import it
 * without creating an import cycle through worker.ts.
 */
export interface Env {
  OAUTH_KV: KVNamespace; // workers-oauth-provider token/client store
  CLIO_TOKENS: KVNamespace; // per-user encrypted Clio-token cache (D1 is the primary) — M3
  DB: D1Database; // per-user OAuth token store: users + clio_tokens + pending_auth — M3
  // Native Rate Limiting binding — per-IP counters guarding the public OAuth endpoints (M6).
  // Optional so the Worker fails OPEN if the binding is ever absent (login must not break on a
  // misconfig); the binding is declared in wrangler.jsonc, so it is present in deploys.
  AUTH_RATE_LIMITER?: RateLimiter;
  // Vars
  CLIO_REGION: string; // EU for the pilot — drives all Clio base + OAuth URLs (M3)
  // Public origin of this Worker (e.g. https://clio-oauth-mcp.beatech.workers.dev). The Leg-2
  // redirect_uri is pinned to this rather than the request host, so it always matches the URI
  // registered on the Clio app regardless of how the request arrived. — M6
  WORKER_BASE_URL: string;
  // Audit logging is OFF unless this is exactly "true". The pilot hosts no tool-call/connection log
  // and deploys no audit_log table by default. To enable: set this var AND apply migrations 0002/0003
  // (which create the append-only audit_log table). Unset = off. — M5
  AUDIT_LOG_ENABLED?: string;
  // Firm allowlist (Leg-2 login gate). Only Clio identities matching one of these may complete login;
  // a Clio Manage private app is not firm-bound, so this is what restricts the connector to the firm.
  // FAIL-CLOSED: if BOTH are unset, no user can connect — set at least one before going live.
  // Comma-separated. ALLOWED_EMAIL_DOMAINS: bare domains matched against the who_am_i email
  // (case-insensitive, exact). ALLOWED_CLIO_USER_IDS: exact who_am_i ids. — see auth/allowlist.ts
  ALLOWED_EMAIL_DOMAINS?: string;
  ALLOWED_CLIO_USER_IDS?: string;
  // Tool write scope. Default (unset / anything but "all") = READ-ONLY: the connector registers only
  // read tools, so the model can't issue a write to Clio. Set to "all" to also register the write
  // tools (create/update/complete). The Clio app's own permission set is the authoritative backstop;
  // this gate just controls what the connector advertises. — see adapter/clioTools.ts
  CLIO_WRITE_SCOPE?: string;
  // Secrets (set via `wrangler secret put`). Optional so the Worker type-checks before
  // the M3 Clio broker needs them.
  ENCRYPTION_KEY?: string;
  CLIO_CLIENT_ID?: string;
  CLIO_CLIENT_SECRET?: string;
  COOKIE_ENCRYPTION_KEY?: string;
  // Injected by OAuthProvider before every handler runs (never a wrangler binding). Lets
  // handlers call back into the AS: parseAuthRequest, lookupClient, completeAuthorization.
  OAUTH_PROVIDER: OAuthHelpers;
}

/**
 * Application props carried inside a Leg-1 access-token grant — the other half of the
 * provider<->handler contract (alongside Env). workers-oauth-provider end-to-end-encrypts
 * this into the access token and decrypts it onto `ctx.props` for every authenticated /mcp
 * request. M3 adds the Clio user id; M4 adds the per-user Clio access token so the upstream
 * tools resolve the right user. M2 carries only the subject.
 */
export interface ConnectorProps {
  /** Our stable Leg-1 subject ("clio-<clioUserId>"); equals the grant userId. */
  userId: string;
  /** Clio's who_am_i id for this user — set by the M3 Clio broker at /clio/callback. */
  clioUserId: string;
  /** Region the user's Clio token is bound to; routes their OAuth + API calls. */
  clioRegion: string;
}
