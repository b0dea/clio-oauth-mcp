import { describe, it, expect, vi } from "vitest";
import { getValidClioToken, saveClioConnection, type ClioTokenRepo } from "../tokenStore.js";
import type { ClioTokenSet } from "../../clio/oauth.js";

const KEY = "weUyM4TL8z6AwAOQkAnA7y2kh9lTiZmdDhxUvFJ8Td0=";

// In-memory ClioTokenRepo — the legitimate storage boundary. The D1 SQL adapter is a thin
// implementation verified live; here we exercise the refresh/decrypt orchestration for real.
function memoryRepo(): ClioTokenRepo & { raw: Map<string, { ciphertext: string; clioRegion: string }> } {
  const raw = new Map<string, { ciphertext: string; clioRegion: string }>();
  return {
    raw,
    async getConnection(userId: string) {
      return raw.get(userId) ?? null;
    },
    async saveConnection(rec) {
      raw.set(rec.userId, { ciphertext: rec.ciphertext, clioRegion: rec.clioRegion });
    },
    async updateTokens(userId: string, ciphertext: string) {
      const cur = raw.get(userId);
      if (cur) raw.set(userId, { ...cur, ciphertext });
    },
  };
}

const future = () => Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days out
const past = () => Date.now() - 1000;

describe("getValidClioToken", () => {
  it("returns the stored access token without refreshing when it is not near expiry", async () => {
    const repo = memoryRepo();
    const refresh = vi.fn();
    await saveClioConnection(repo, KEY, { userId: "u-a", clioUserId: "1", clioRegion: "EU" }, {
      accessToken: "acc-a",
      refreshToken: "ref-a",
      expiresAt: future(),
    });

    const { accessToken, region } = await getValidClioToken(repo, KEY, refresh, "u-a");
    expect(accessToken).toBe("acc-a");
    expect(region).toBe("EU");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes an expired token, persists it, and does not refresh again next time", async () => {
    const repo = memoryRepo();
    const refresh = vi.fn(async (region: string, refreshToken: string): Promise<ClioTokenSet> => {
      expect(region).toBe("EU");
      expect(refreshToken).toBe("ref-a");
      return { accessToken: "acc-NEW", refreshToken: "ref-a", expiresAt: future() };
    });
    await saveClioConnection(repo, KEY, { userId: "u-a", clioUserId: "1", clioRegion: "EU" }, {
      accessToken: "acc-OLD",
      refreshToken: "ref-a",
      expiresAt: past(),
    });

    const first = await getValidClioToken(repo, KEY, refresh, "u-a");
    expect(first.accessToken).toBe("acc-NEW");
    expect(refresh).toHaveBeenCalledTimes(1);

    const second = await getValidClioToken(repo, KEY, refresh, "u-a");
    expect(second.accessToken).toBe("acc-NEW");
    expect(refresh).toHaveBeenCalledTimes(1); // persisted, so no second refresh
  });

  it("throws a clear error when the user has no connection", async () => {
    const repo = memoryRepo();
    await expect(getValidClioToken(repo, KEY, vi.fn(), "nobody")).rejects.toThrow(/not connected/i);
  });

  it("isolates users: A's token is never returned for B (top invariant)", async () => {
    const repo = memoryRepo();
    const refresh = vi.fn();
    await saveClioConnection(repo, KEY, { userId: "u-a", clioUserId: "1", clioRegion: "EU" }, {
      accessToken: "acc-a", refreshToken: "ref-a", expiresAt: future(),
    });
    await saveClioConnection(repo, KEY, { userId: "u-b", clioUserId: "2", clioRegion: "EU" }, {
      accessToken: "acc-b", refreshToken: "ref-b", expiresAt: future(),
    });

    expect((await getValidClioToken(repo, KEY, refresh, "u-a")).accessToken).toBe("acc-a");
    expect((await getValidClioToken(repo, KEY, refresh, "u-b")).accessToken).toBe("acc-b");
  });

  it("stores tokens as ciphertext at rest, not plaintext", async () => {
    const repo = memoryRepo();
    await saveClioConnection(repo, KEY, { userId: "u-a", clioUserId: "1", clioRegion: "EU" }, {
      accessToken: "super-secret-token", refreshToken: "ref-a", expiresAt: future(),
    });
    const stored = repo.raw.get("u-a")!;
    expect(stored.ciphertext).not.toContain("super-secret-token");
    expect(stored.ciphertext).not.toContain("ref-a");
  });
});
