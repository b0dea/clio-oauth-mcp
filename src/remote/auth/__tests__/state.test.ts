import { describe, it, expect } from "vitest";
import { createPendingAuth, consumePendingAuth, type PendingAuthRepo } from "../state.js";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";

function memRepo(): PendingAuthRepo {
  const m = new Map<string, { authReqJson: string; expiresAt: number }>();
  return {
    async put(state, authReqJson, expiresAt) {
      m.set(state, { authReqJson, expiresAt });
    },
    async take(state) {
      const row = m.get(state) ?? null;
      m.delete(state); // one-time
      return row;
    },
  };
}

const AUTH_REQ = {
  responseType: "code",
  clientId: "client-1",
  redirectUri: "https://claude.ai/api/mcp/auth_callback",
  scope: [],
  state: "claude-state",
  codeChallenge: "abc",
  codeChallengeMethod: "S256",
  resource: "https://w.example/mcp",
} as AuthRequest;

describe("pending-auth state (Leg-2 CSRF)", () => {
  it("round-trips the auth request and issues an unguessable, unique state", async () => {
    const repo = memRepo();
    const s1 = await createPendingAuth(repo, AUTH_REQ);
    const s2 = await createPendingAuth(repo, AUTH_REQ);
    expect(s1).not.toBe(s2);
    expect(s1).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes, hex

    const resumed = await consumePendingAuth(repo, s1);
    expect(resumed).toEqual(AUTH_REQ);
  });

  it("is single-use: consuming the same state twice fails the second time", async () => {
    const repo = memRepo();
    const s = await createPendingAuth(repo, AUTH_REQ);
    expect(await consumePendingAuth(repo, s)).not.toBeNull();
    expect(await consumePendingAuth(repo, s)).toBeNull();
  });

  it("rejects an unknown state", async () => {
    const repo = memRepo();
    expect(await consumePendingAuth(repo, "deadbeef")).toBeNull();
  });

  it("rejects an expired state", async () => {
    const repo = memRepo();
    const s = await createPendingAuth(repo, AUTH_REQ, -1000); // already expired
    expect(await consumePendingAuth(repo, s)).toBeNull();
  });
});
