/**
 * The OAuthProvider `defaultHandler`: everything that isn't the protected /mcp api route or
 * a provider-owned OAuth endpoint (/token, /register, /.well-known/*). The provider injects
 * `env.OAUTH_PROVIDER` before calling us, so /authorize can drive the AS callbacks.
 *
 * M2 stands in for the real user with a hardcoded identity: /authorize renders a trivial
 * consent page and, on approval, mints a Leg-1 grant for DUMMY_IDENTITY. M3 replaces this
 * whole handler with the Clio broker — /authorize redirects to Clio, /clio/callback maps the
 * real who_am_i identity, and the consent below goes away.
 */

import { Hono } from "hono";

import type { Env, ConnectorProps } from "../env.js";

// Hardcoded stand-in identity for M2. M3 replaces this whole handler with the Clio broker:
// /authorize redirects to Clio and /clio/callback maps a real who_am_i onto ConnectorProps.
const DUMMY_IDENTITY = { userId: "dummy-user" } satisfies ConnectorProps;

export const defaultHandler = new Hono<{ Bindings: Env }>();

defaultHandler.on(["GET", "HEAD"], ["/", "/health"], (c) =>
  c.json({
    service: "clio-oauth-mcp",
    status: "ok",
    region: c.env.CLIO_REGION ?? "unset",
    note: "M2 — Leg 1 OAuth live (workers-oauth-provider). /mcp requires a bearer token; the upstream identity is a hardcoded dummy until M3.",
  }),
);

// Leg-1 authorization UI. The provider implements /token, /register, and the metadata
// endpoints itself; /authorize is ours to render. Two phases on the same URL: first GET
// shows consent, the Approve link re-requests with approve=1 to mint the grant. The dummy
// identity makes CSRF moot here (every grant is the same user); M3's real auth happens at
// Clio's own domain with state/PKCE.
defaultHandler.get("/authorize", async (c) => {
  // parseAuthRequest validates the client_id, redirect_uri, resource, and PKCE method,
  // throwing on any mismatch. Those are bad-client-request errors, not server faults — map
  // them to 400 instead of letting onError surface a 500. We must not redirect on these
  // (the redirect_uri itself may be the thing that failed validation).
  let oauthReqInfo;
  try {
    oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  } catch (err) {
    console.error("invalid /authorize request:", err);
    return c.json({ error: "invalid_request", error_description: "Invalid authorization request" }, 400);
  }

  // RFC 8707: require the client to bind the grant to a resource (our /mcp URL). The provider
  // only enforces token audience when an audience is present, and an audience is only set when
  // the client sends `resource` — so without this guard a client that omits it gets an
  // audience-less token that passes the /mcp gate for any resource. That is exactly the
  // confused-deputy boundary build-notes §1 calls the security crux. Claude and the MCP
  // Inspector always send `resource`; reject the request if it is missing rather than mint an
  // unbound token. (The value itself is checked at /mcp via audienceMatches.)
  if (!oauthReqInfo.resource) {
    return c.json(
      { error: "invalid_request", error_description: "Missing required resource parameter (RFC 8707)" },
      400,
    );
  }

  if (c.req.query("approve") !== "1") {
    const approveUrl = new URL(c.req.url);
    approveUrl.searchParams.set("approve", "1");
    return c.html(renderConsent(oauthReqInfo.clientId, approveUrl.pathname + approveUrl.search));
  }

  try {
    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthReqInfo,
      userId: DUMMY_IDENTITY.userId,
      metadata: { via: "m2-dummy" },
      scope: oauthReqInfo.scope,
      props: DUMMY_IDENTITY,
    });
    return c.redirect(redirectTo, 302);
  } catch (err) {
    // completeAuthorization throws on an unregistered redirect_uri or a malformed resource
    // parameter — a bad client request, not a server fault. Stay non-revealing.
    console.error("completeAuthorization rejected:", err);
    return c.json({ error: "invalid_request", error_description: "Authorization request rejected" }, 400);
  }
});

// Leg-2 return endpoint — implemented in M3 (Clio code exchange + token store).
defaultHandler.all("/clio/callback", (c) =>
  c.json({ error: "not_implemented", milestone: "M3 — Leg 2 OAuth (Clio broker)" }, 501),
);

defaultHandler.onError((err, c) => {
  console.error("default handler error:", err);
  return c.json({ error: "server_error" }, 500);
});

defaultHandler.notFound((c) => c.text("Not found", 404));

// clientId is provider-generated and opaque; the path is same-origin. Neither is
// client-controlled free text, so the page renders no untrusted strings.
function renderConsent(clientId: string, approveHref: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize connector</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem;">
<h1>Authorize Clio MCP connector</h1>
<p>Client <code>${clientId}</code> is requesting access to this connector.</p>
<p><strong>M2 pilot:</strong> approving connects a hardcoded test identity (real Clio sign-in arrives in M3).</p>
<p><a href="${approveHref}" style="display:inline-block; padding:0.6rem 1.2rem; background:#1a7f5a; color:#fff; text-decoration:none; border-radius:6px;">Approve</a></p>
</body>
</html>`;
}
