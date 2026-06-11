import { describe, it, expect, vi, afterEach } from "vitest";
import {
  clioRegionHost,
  clioApiBase,
  buildClioAuthorizeUrl,
  exchangeClioCode,
  refreshClioTokens,
  fetchClioIdentity,
} from "../oauth.js";

const CFG = { region: "EU", clientId: "cid-123", clientSecret: "secret-xyz" };

afterEach(() => vi.unstubAllGlobals());

// Mock global fetch with a single JSON response and capture the request.
function mockFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

describe("Clio region routing", () => {
  it("maps regions to the right host, case-insensitively", () => {
    expect(clioRegionHost("EU")).toBe("eu.app.clio.com");
    expect(clioRegionHost("us")).toBe("app.clio.com");
    expect(clioRegionHost("CA")).toBe("ca.app.clio.com");
    expect(clioApiBase("EU")).toBe("https://eu.app.clio.com/api/v4");
  });

  it("throws on an unknown region rather than guessing", () => {
    expect(() => clioRegionHost("mars")).toThrow(/region/i);
  });
});

describe("buildClioAuthorizeUrl", () => {
  it("targets the regional /oauth/authorize with code flow, our redirect+state, and NO scope", () => {
    const url = new URL(buildClioAuthorizeUrl(CFG, "https://w.example/clio/callback", "state-abc"));
    expect(url.origin + url.pathname).toBe("https://eu.app.clio.com/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("cid-123");
    expect(url.searchParams.get("redirect_uri")).toBe("https://w.example/clio/callback");
    expect(url.searchParams.get("state")).toBe("state-abc");
    expect(url.searchParams.has("scope")).toBe(false); // Clio scope is app-level, not per-request
  });
});

describe("exchangeClioCode", () => {
  it("POSTs the code as form-encoded and parses Clio's JSON response", async () => {
    const calls = mockFetch(200, { access_token: "acc-1", refresh_token: "ref-1", expires_in: 2592000 });
    const before = Date.now();
    const tokens = await exchangeClioCode(CFG, "the-code", "https://w.example/clio/callback");

    expect(tokens.accessToken).toBe("acc-1");
    expect(tokens.refreshToken).toBe("ref-1");
    expect(tokens.expiresAt).toBeGreaterThan(before);
    expect(tokens.expiresAt).toBeLessThanOrEqual(Date.now() + 2592000 * 1000);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://eu.app.clio.com/oauth/token");
    expect(calls[0].init.method).toBe("POST");
    const body = String(calls[0].init.body);
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code=the-code");
    expect(body).toContain("client_secret=secret-xyz");
  });

  it("throws without leaking the client secret on a non-2xx response", async () => {
    mockFetch(401, { error: "invalid_client" });
    await expect(exchangeClioCode(CFG, "bad", "https://w.example/clio/callback")).rejects.toThrow(/clio token/i);
    await expect(exchangeClioCode(CFG, "bad", "https://w.example/clio/callback")).rejects.not.toThrow(/secret-xyz/);
  });

  it("throws if the code exchange response omits a refresh_token (won't persist an un-refreshable token)", async () => {
    mockFetch(200, { access_token: "acc-1", expires_in: 2592000 }); // no refresh_token
    await expect(exchangeClioCode(CFG, "the-code", "https://w.example/clio/callback")).rejects.toThrow(/refresh_token/);
  });
});

describe("refreshClioTokens", () => {
  it("keeps the old refresh token when Clio omits a new one (non-rotating)", async () => {
    mockFetch(200, { access_token: "acc-2", expires_in: 2592000 }); // no refresh_token in response
    const tokens = await refreshClioTokens(CFG, "ref-original");
    expect(tokens.accessToken).toBe("acc-2");
    expect(tokens.refreshToken).toBe("ref-original");
  });
});

describe("fetchClioIdentity", () => {
  it("reads who_am_i with field selection and unwraps data", async () => {
    const calls = mockFetch(200, { data: { id: 42, name: "Ada Lovelace", email: "ada@firm.example" } });
    const id = await fetchClioIdentity("EU", "acc-1");
    expect(id).toEqual({ id: "42", name: "Ada Lovelace", email: "ada@firm.example" });
    expect(calls[0].url).toContain("https://eu.app.clio.com/api/v4/users/who_am_i");
    expect(calls[0].url).toContain("fields=id");
  });
});
