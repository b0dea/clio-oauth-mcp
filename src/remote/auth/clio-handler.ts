/**
 * The OAuthProvider `defaultHandler` — the Clio broker (Leg 2: us <-> Clio). Replaces the M2
 * dummy identity with a real per-user Clio login. The provider injects `env.OAUTH_PROVIDER`
 * before calling us, owns /token + /register + /.well-known/*, and gates /mcp; everything else
 * (/, /health, /authorize, /clio/callback) lands here.
 *
 * Flow:
 *   /authorize     parse the Leg-1 request, stash it against a one-time `state` in D1, redirect
 *                  to Clio's regional /oauth/authorize.
 *   /clio/callback consume the state (single-use CSRF), exchange the code at Clio (JSON), read
 *                  who_am_i, encrypt+store the tokens per user, then completeAuthorization to mint
 *                  the Leg-1 token bound to the real identity.
 */

import { Hono } from "hono";

import type { Env, ConnectorProps } from "../env.js";
import { consumePendingAuth, createPendingAuth, d1PendingAuthRepo } from "./state.js";
import { buildClioAuthorizeUrl, exchangeClioCode, fetchClioIdentity } from "../clio/oauth.js";
import { clioConfigFromEnv, requireEncryptionKey } from "../clio/connector.js";
import { d1TokenRepo, saveClioConnection } from "../storage/tokenStore.js";

export const clioHandler = new Hono<{ Bindings: Env }>();

clioHandler.on(["GET", "HEAD"], ["/", "/health"], (c) =>
  c.json({
    service: "clio-oauth-mcp",
    status: "ok",
    region: c.env.CLIO_REGION ?? "unset",
    note: "M3 — Leg 1 + Leg 2 OAuth live. /mcp requires a bearer token; each user connects their own Clio account.",
  }),
);

// Leg-1 authorize: validated, then handed off to Clio. No local consent page — consent happens
// at Clio's own login. We require the RFC 8707 `resource` so every minted token is audience-bound
// to this /mcp URL (the provider only audience-checks tokens that carry an audience).
clioHandler.get("/authorize", async (c) => {
  let authReq;
  try {
    authReq = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  } catch (err) {
    console.error("invalid /authorize request:", err instanceof Error ? err.message : String(err));
    return c.json({ error: "invalid_request", error_description: "Invalid authorization request" }, 400);
  }
  if (!authReq.resource) {
    return c.json(
      { error: "invalid_request", error_description: "Missing required resource parameter (RFC 8707)" },
      400,
    );
  }

  let cfg;
  try {
    cfg = clioConfigFromEnv(c.env);
  } catch (err) {
    console.error("connector not configured:", err instanceof Error ? err.message : String(err));
    return c.json({ error: "temporarily_unavailable", error_description: "Connector is not configured" }, 503);
  }

  const state = await createPendingAuth(d1PendingAuthRepo(c.env.DB), authReq);
  return c.redirect(buildClioAuthorizeUrl(cfg, callbackRedirectUri(c.env.WORKER_BASE_URL), state), 302);
});

// Leg-2 return: Clio redirects the user here after they log in.
clioHandler.get("/clio/callback", async (c) => {
  const url = new URL(c.req.url);
  const clioError = url.searchParams.get("error");
  if (clioError) {
    // `error` is a client-reachable query param — sanitize before logging to avoid log injection.
    console.error("Clio authorization denied/failed:", clioError.slice(0, 64).replace(/[^\w.:-]/g, "?"));
    return c.html(errorPage("Clio sign-in was denied or failed. You can close this tab and try again."), 400);
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return c.html(errorPage("Missing authorization code or state from Clio."), 400);
  }

  // Single-use state: consuming it both authenticates the callback (CSRF) and resumes Leg 1.
  const authReq = await consumePendingAuth(d1PendingAuthRepo(c.env.DB), state);
  if (!authReq) {
    return c.html(errorPage("This sign-in link has expired or was already used. Please reconnect from Claude."), 400);
  }

  try {
    const cfg = clioConfigFromEnv(c.env);
    const encryptionKey = requireEncryptionKey(c.env);

    const tokens = await exchangeClioCode(cfg, code, callbackRedirectUri(c.env.WORKER_BASE_URL));
    const identity = await fetchClioIdentity(c.env.CLIO_REGION, tokens.accessToken);
    const userId = `clio-${identity.id}`; // stable per Clio user; no ':' (the token format reserves it)

    await saveClioConnection(
      d1TokenRepo(c.env.DB),
      encryptionKey,
      { userId, clioUserId: identity.id, clioRegion: c.env.CLIO_REGION, name: identity.name, email: identity.email },
      tokens,
    );

    const props: ConnectorProps = { userId, clioUserId: identity.id, clioRegion: c.env.CLIO_REGION };
    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      request: authReq,
      userId,
      metadata: { clioUserId: identity.id },
      scope: authReq.scope,
      props,
    });
    return c.redirect(redirectTo, 302);
  } catch (err) {
    // Clio exchange/identity failure, or a store/mint fault. Log the message (not the raw error, which
    // could carry response detail); keep the page generic.
    console.error("Clio callback failed:", err instanceof Error ? err.message : String(err));
    return c.html(errorPage("Could not complete Clio sign-in. Please close this tab and try again."), 502);
  }
});

clioHandler.onError((err, c) => {
  console.error("clio handler error:", err instanceof Error ? err.message : String(err));
  return c.json({ error: "server_error" }, 500);
});

clioHandler.notFound((c) => c.text("Not found", 404));

// The redirect_uri must be byte-identical at /authorize and at the /clio/callback token exchange
// (OAuth requires the match), and must equal what's registered on the Clio app. Pin it to
// WORKER_BASE_URL config — not the request host — so a preview URL, custom domain, or spoofed Host
// header can never change the redirect_uri Clio sees. Fail loud if it is unset.
export function callbackRedirectUri(baseUrl: string | undefined): string {
  if (!baseUrl) {
    throw new Error("WORKER_BASE_URL is not configured");
  }
  return new URL("/clio/callback", baseUrl).toString();
}

// Static, no client-controlled strings — safe to interpolate the fixed message.
function errorPage(message: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Clio connector</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem;">
<h1>Clio connector</h1>
<p>${message}</p>
</body>
</html>`;
}
