/**
 * Worker-native Clio OAuth client (Leg 2: us -> Clio). Deliberately NOT the upstream
 * `src/auth/oauth.ts` helpers: those read `process.env` and use loopback `http`, which is the
 * wrong source of truth in a multi-tenant Worker (config lives on the per-request `env`
 * binding). The logic is small, so we own a clean version that takes config explicitly.
 *
 * Clio specifics (docs/build-notes.md §6): OAuth + API live on the same regional host; tokens
 * are region-bound; the OAuth flow takes NO `scope` (scope is app-level); the token endpoint
 * returns JSON (the GitHub template's `formData()` would be wrong here); refresh tokens are
 * non-rotating (the refresh response omits `refresh_token`).
 */

export interface ClioOAuthConfig {
  region: string;
  clientId: string;
  clientSecret: string;
}

export interface ClioTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

export interface ClioIdentity {
  id: string;
  name?: string;
  email?: string;
}

// US `app.clio.com`, EU `eu.app.clio.com`, CA `ca.app.clio.com`, AU `au.app.clio.com`.
const REGION_HOSTS: Record<string, string> = {
  us: "app.clio.com",
  eu: "eu.app.clio.com",
  ca: "ca.app.clio.com",
  au: "au.app.clio.com",
};

export function clioRegionHost(region: string): string {
  const host = REGION_HOSTS[region.toLowerCase()];
  if (!host) {
    throw new Error(`Unknown Clio region "${region}" (expected one of: ${Object.keys(REGION_HOSTS).join(", ")})`);
  }
  return host;
}

export function clioApiBase(region: string): string {
  return `https://${clioRegionHost(region)}/api/v4`;
}

function clioOAuthBase(region: string): string {
  return `https://${clioRegionHost(region)}/oauth`;
}

export function buildClioAuthorizeUrl(cfg: ClioOAuthConfig, redirectUri: string, state: string): string {
  // No `scope`: Clio scope is set on the app in the Developer Portal, not per-request.
  const params = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    state,
  });
  return `${clioOAuthBase(cfg.region)}/authorize?${params}`;
}

async function postToken(cfg: ClioOAuthConfig, body: URLSearchParams): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const res = await fetch(`${clioOAuthBase(cfg.region)}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  if (!res.ok) {
    // Surface the HTTP status (and Clio's error code if present) but never the request body,
    // which carries the client secret. Read as text so a non-JSON error page can't throw here.
    const detail = await res.text().catch(() => "");
    let code = "";
    try {
      code = (JSON.parse(detail).error as string) ?? "";
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`Clio token endpoint returned ${res.status}${code ? ` (${code})` : ""}`);
  }
  return res.json();
}

export async function exchangeClioCode(cfg: ClioOAuthConfig, code: string, redirectUri: string): Promise<ClioTokenSet> {
  const data = await postToken(
    cfg,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: redirectUri,
    }),
  );
  // The initial code exchange must yield a refresh token (unlike the non-rotating refresh
  // response, which omits it). Fail loudly rather than persist an empty, un-refreshable token.
  if (!data.refresh_token) {
    throw new Error("Clio authorization response did not include a refresh_token");
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

export async function refreshClioTokens(cfg: ClioOAuthConfig, refreshToken: string): Promise<ClioTokenSet> {
  const data = await postToken(
    cfg,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    }),
  );
  return {
    accessToken: data.access_token,
    // Clio refresh tokens are non-rotating: the response omits refresh_token — keep the old one.
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

export async function fetchClioIdentity(region: string, accessToken: string): Promise<ClioIdentity> {
  const url = `${clioApiBase(region)}/users/who_am_i?fields=id,name,email`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Clio who_am_i returned ${res.status}`);
  }
  const body = (await res.json()) as { data?: { id?: unknown; name?: string; email?: string } };
  const id = body.data?.id;
  if (id === undefined || id === null) {
    throw new Error("Clio who_am_i response missing data.id");
  }
  return { id: String(id), name: body.data?.name, email: body.data?.email };
}
