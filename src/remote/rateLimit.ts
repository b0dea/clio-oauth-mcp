/**
 * Per-IP rate limiting for the public OAuth endpoints (M6 hardening). /token and /register are
 * owned by the OAuthProvider and never reach our Hono handlers, so the only chokepoint covering all
 * four public endpoints sits in front of provider.fetch (see worker.ts). Backed by the Workers
 * native Rate Limiting binding — ephemeral edge counters, so this adds NO persistent activity log.
 *
 * Keyed by client IP: /authorize and /clio/callback carry the end-user's browser IP, while /token
 * and /register come from the MCP client's (shared) egress IPs — hence a generous per-IP limit
 * (tunable via the binding) so legitimate shared-IP traffic is not throttled while brute-force
 * floods still trip. /mcp is excluded: it is bearer-gated and Clio rate-limits per access token. The
 * provider-owned /.well-known/* metadata endpoints are also intentionally unthrottled — cheap GETs
 * clients must reach to discover the AS.
 */

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

const RATE_LIMITED_PATHS = new Set(["/authorize", "/token", "/register", "/clio/callback"]);

/**
 * Enforce the per-IP limit on the four public endpoints. Returns a 429 Response when the limit is
 * exceeded, or null to let the request proceed. Non-public paths and a missing limiter (the limit is
 * defense-in-depth, not a correctness gate — never brick login on a binding misconfig) pass through.
 */
export async function enforcePublicRateLimit(request: Request, limiter: RateLimiter | undefined): Promise<Response | null> {
  if (!limiter) return null;

  const path = new URL(request.url).pathname;
  if (!RATE_LIMITED_PATHS.has(path)) return null;

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await limiter.limit({ key: ip });
  if (success) return null;

  return new Response(
    JSON.stringify({ error: "rate_limited", error_description: "Too many requests. Please retry shortly." }),
    { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "60" } },
  );
}
