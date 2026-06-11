/**
 * Cross-user isolation (PRD §7 top invariant): authenticated as user A, no code path may reach
 * user B's tokens or Clio data. This exercises the REAL injection seam end-to-end — the same one
 * mcp/api.ts installs per request: getValidClioToken (lookup keyed strictly by user_id) ->
 * AES-256-GCM decrypt -> buildClioSessionContext -> sessionStorage.run -> the real upstream Clio
 * tool -> clioClient.resolveAccessToken -> the outbound Bearer header. We capture that header to
 * prove the token that actually reaches "Clio" is only ever the authenticated user's.
 *
 * No real Clio creds needed: an in-memory ClioTokenRepo (real crypto) plus a stubbed global fetch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// The ported Clio tools call appendAuditLog. In the Node test runtime that resolves to upstream's
// fs-backed module (writes ~/.clio-mcp, reaches for ctx.getTokens()); the Worker swaps it for the
// D1 shim via the wrangler alias. Audit is incidental to isolation, so stub it to a no-op and keep
// the test on the token seam rather than the home-dir audit file.
vi.mock("../../../utils/auditLog.js", () => ({ appendAuditLog: vi.fn(async () => {}) }));

import { buildMcpServer, type McpDeps } from "../server.js";
import { api } from "../api.js";
import { saveClioConnection, getValidClioToken, type ClioTokenRepo } from "../../storage/tokenStore.js";
import { buildClioSessionContext } from "../../adapter/sessionContext.js";
import { sessionStorage } from "../../../utils/sessionContext.js";
import type { Env } from "../../env.js";

// 32-byte base64 AES-256 key (test-only), same as tokenStore.test.ts.
const KEY = "weUyM4TL8z6AwAOQkAnA7y2kh9lTiZmdDhxUvFJ8Td0=";
const future = () => Date.now() + 30 * 24 * 60 * 60 * 1000;

/** In-memory ClioTokenRepo — the legitimate storage boundary; lookups keyed strictly by user_id. */
function memoryRepo(): ClioTokenRepo {
  const raw = new Map<string, { ciphertext: string; clioRegion: string; expiresAt: number }>();
  return {
    async getConnection(userId) {
      const r = raw.get(userId);
      return r ? { ciphertext: r.ciphertext, clioRegion: r.clioRegion } : null;
    },
    async saveConnection(rec) {
      raw.set(rec.userId, { ciphertext: rec.ciphertext, clioRegion: rec.clioRegion, expiresAt: rec.expiresAt });
    },
    async updateTokens(userId, ciphertext, expiresAt, prevExpiresAt) {
      const cur = raw.get(userId);
      if (cur && cur.expiresAt === prevExpiresAt) raw.set(userId, { ...cur, ciphertext, expiresAt });
    },
  };
}

// The Bearer token the most recent outbound Clio request carried — the thing under test.
let capturedAuth: string | null = null;

const fakeClioFetch = vi.fn(async (_url: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  capturedAuth = headers.get("Authorization");
  // Minimal valid /matters.json response so the real list_matters tool runs to completion.
  return new Response(JSON.stringify({ data: [{ id: 1, display_number: "0001", status: "open" }], meta: { paging: {} } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

beforeEach(() => {
  capturedAuth = null;
  fakeClioFetch.mockClear();
  vi.stubGlobal("fetch", fakeClioFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function depsFor(userId: string): McpDeps {
  return {
    auth: { userId, clioUserId: userId.replace(/^clio-/, "") },
    whoami: async () => {
      throw new Error("whoami is not exercised by these data-tool isolation tests");
    },
  };
}

/**
 * Mirror mcp/api.ts: resolve THIS user's token through the seam, then run one MCP tool call inside
 * the AsyncLocalStorage context so the upstream tool resolves the injected token. Returns the
 * captured outbound Bearer header.
 */
async function bearerSeenFor(repo: ClioTokenRepo, userId: string, args: Record<string, unknown> = {}): Promise<string | null> {
  const ctx = buildClioSessionContext(userId, async () => {
    const refreshMustNotRun = async () => {
      throw new Error("refresh should not run for a non-expired token");
    };
    return (await getValidClioToken(repo, KEY, refreshMustNotRun, userId)).accessToken;
  });
  return sessionStorage.run(ctx, async () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer(depsFor(userId));
    const client = new Client({ name: "iso-test", version: "0.0.0" });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    await client.callTool({ name: "clio_list_matters", arguments: args });
    return capturedAuth;
  });
}

async function twoConnectedUsers(): Promise<ClioTokenRepo> {
  const repo = memoryRepo();
  await saveClioConnection(repo, KEY, { userId: "clio-A", clioUserId: "A", clioRegion: "EU" }, {
    accessToken: "token-A", refreshToken: "ref-A", expiresAt: future(),
  });
  await saveClioConnection(repo, KEY, { userId: "clio-B", clioUserId: "B", clioRegion: "EU" }, {
    accessToken: "token-B", refreshToken: "ref-B", expiresAt: future(),
  });
  return repo;
}

describe("cross-user isolation (end-to-end seam)", () => {
  it("each user's MCP turn drives Clio with only their own token", async () => {
    const repo = await twoConnectedUsers();
    expect(await bearerSeenFor(repo, "clio-A")).toBe("Bearer token-A");
    expect(await bearerSeenFor(repo, "clio-B")).toBe("Bearer token-B");
  });

  it("user A's turn cannot select user B's token even with attacker-controlled tool args", async () => {
    const repo = await twoConnectedUsers();
    // Identity is taken from the authenticated seam, never from caller input: injecting a foreign
    // user id / token into the tool arguments changes nothing.
    const seen = await bearerSeenFor(repo, "clio-A", { limit: 5, user_id: "clio-B", userId: "clio-B", token: "token-B" });
    expect(seen).toBe("Bearer token-A");
  });
});

describe("identity comes from authenticated props, never caller input", () => {
  function ctxWith(props: unknown): ExecutionContext {
    return { props, waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  }
  function mcpPost(): Request {
    return new Request("https://conn.example/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
  }

  it("refuses to serve a session when authenticated props are missing (fails loud, not silently open)", async () => {
    const res = await api.fetch(mcpPost(), {} as Env, ctxWith(undefined));
    expect(res.status).toBe(500);
  });

  it("refuses to serve a session when props carry no userId", async () => {
    const res = await api.fetch(mcpPost(), {} as Env, ctxWith({ clioUserId: "B" }));
    expect(res.status).toBe(500);
  });
});
