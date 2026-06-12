/**
 * Clio broker (default handler) hardening: the Leg-2 redirect URI must be pinned to WORKER_BASE_URL
 * config (P1 — never derived from the request host), and /authorize must enforce the RFC 8707
 * `resource` param so every minted Leg-1 token is audience-bound.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";

import { clioHandler, callbackRedirectUri } from "../clio-handler.js";
import type { Env } from "../../env.js";

const PINNED_BASE = "https://clio-oauth-mcp.beatech.workers.dev";

const AUTH_REQ = {
  responseType: "code",
  clientId: "client-1",
  redirectUri: "https://claude.ai/api/mcp/auth_callback",
  scope: [],
  state: "claude-state",
  codeChallenge: "abc",
  codeChallengeMethod: "S256",
  resource: "https://clio-oauth-mcp.beatech.workers.dev/mcp",
} as AuthRequest;

// Minimal D1 stub: createPendingAuth only needs prepare().bind() statements that batch() accepts.
const fakeDB = {
  prepare: () => ({ bind: () => ({}) }),
  batch: async () => [],
} as unknown as Env["DB"];

function env(overrides?: Partial<Env>, authReq: Partial<AuthRequest> = AUTH_REQ): Env {
  return {
    WORKER_BASE_URL: PINNED_BASE,
    CLIO_REGION: "EU",
    CLIO_CLIENT_ID: "cid",
    CLIO_CLIENT_SECRET: "csecret",
    DB: fakeDB,
    OAUTH_PROVIDER: { parseAuthRequest: async () => authReq as AuthRequest },
    ...overrides,
  } as unknown as Env;
}

describe("callbackRedirectUri (redirect-URI pinned to config)", () => {
  it("derives the Clio callback from WORKER_BASE_URL", () => {
    expect(callbackRedirectUri(PINNED_BASE)).toBe(`${PINNED_BASE}/clio/callback`);
  });

  it("fails loud when WORKER_BASE_URL is unset rather than falling back to the request host", () => {
    expect(() => callbackRedirectUri(undefined)).toThrow(/WORKER_BASE_URL/);
  });
});

describe("GET /authorize", () => {
  it("pins the Clio redirect_uri to WORKER_BASE_URL even when the request arrives on another host", async () => {
    // A request reaching a preview URL / custom domain / spoofed Host must not change what Clio sees.
    const res = await clioHandler.fetch(new Request("https://some-other-host.example/authorize"), env());
    expect(res.status).toBe(302);
    const redirectUri = new URL(res.headers.get("Location")!).searchParams.get("redirect_uri");
    expect(redirectUri).toBe(`${PINNED_BASE}/clio/callback`);
  });

  it("rejects a request missing the RFC 8707 resource param (audience binding) with 400", async () => {
    const res = await clioHandler.fetch(
      new Request(`${PINNED_BASE}/authorize`),
      env(undefined, { ...AUTH_REQ, resource: undefined }),
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /clio/callback (firm allowlist gate)", () => {
  afterEach(() => vi.unstubAllGlobals());

  // 32 zero bytes, base64 — a valid AES-256 key so the pass-through case can encrypt.
  const ZERO_KEY = "A".repeat(43) + "=";

  // Clio's two callback fetches: token exchange, then who_am_i identity.
  function stubClioFetch(identity: { id: string | number; email?: string; name?: string }) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
        if (url.includes("/oauth/token")) return json({ access_token: "acc", refresh_token: "ref", expires_in: 3600 });
        if (url.includes("who_am_i")) return json({ data: identity });
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
  }

  // DB stub: consumePendingAuth reads a live pending row; saveConnection batches. `batch` is spied so
  // we can assert a rejected login persists nothing.
  function callbackEnv(overrides: Partial<Env>, batch = vi.fn(async () => [])) {
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => ({ authReqJson: JSON.stringify(AUTH_REQ), expiresAt: Date.now() + 60_000 }),
        }),
      }),
      batch,
    } as unknown as Env["DB"];
    const completeAuthorization = vi.fn(async () => ({ redirectTo: "https://claude.ai/done" }));
    const e = {
      WORKER_BASE_URL: PINNED_BASE,
      CLIO_REGION: "EU",
      CLIO_CLIENT_ID: "cid",
      CLIO_CLIENT_SECRET: "csecret",
      ENCRYPTION_KEY: ZERO_KEY,
      DB: db,
      OAUTH_PROVIDER: { completeAuthorization },
      ...overrides,
    } as unknown as Env;
    return { env: e, batch, completeAuthorization };
  }

  const callback = () => new Request(`${PINNED_BASE}/clio/callback?code=abc&state=xyz`);

  it("rejects a non-firm identity with 403 and persists / mints nothing", async () => {
    stubClioFetch({ id: "999", email: "attacker@evil.com" });
    const { env: e, batch, completeAuthorization } = callbackEnv({ ALLOWED_EMAIL_DOMAINS: "firm.co.uk" });

    const res = await clioHandler.fetch(callback(), e);

    expect(res.status).toBe(403);
    expect(batch).not.toHaveBeenCalled(); // no token row written
    expect(completeAuthorization).not.toHaveBeenCalled(); // no Leg-1 token minted
  });

  it("fails closed: with no allowlist configured even a plausible firm user is rejected", async () => {
    stubClioFetch({ id: "42", email: "ada@firm.co.uk" });
    const { env: e } = callbackEnv({}); // no ALLOWED_* vars

    const res = await clioHandler.fetch(callback(), e);
    expect(res.status).toBe(403);
  });

  it("lets an allowlisted firm identity through (302, persists + mints)", async () => {
    stubClioFetch({ id: "42", email: "ada@firm.co.uk" });
    const { env: e, batch, completeAuthorization } = callbackEnv({ ALLOWED_EMAIL_DOMAINS: "firm.co.uk" });

    const res = await clioHandler.fetch(callback(), e);

    expect(res.status).toBe(302);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(completeAuthorization).toHaveBeenCalledTimes(1);
  });
});
