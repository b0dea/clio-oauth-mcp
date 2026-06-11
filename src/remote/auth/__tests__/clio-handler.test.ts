/**
 * Clio broker (default handler) hardening: the Leg-2 redirect URI must be pinned to WORKER_BASE_URL
 * config (P1 — never derived from the request host), and /authorize must enforce the RFC 8707
 * `resource` param so every minted Leg-1 token is audience-bound.
 */

import { describe, it, expect } from "vitest";
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
