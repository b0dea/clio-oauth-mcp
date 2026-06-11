import { describe, it, expect, vi } from "vitest";
import { kvCachedTokenRepo } from "../kvTokenRepo.js";
import type { ClioTokenRepo } from "../tokenStore.js";

// Minimal in-memory KV (only the three methods the cache uses), cast to KVNamespace.
function fakeKv() {
  const store = new Map<string, string>();
  const kv = {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
    delete: vi.fn(async (k: string) => { store.delete(k); }),
  };
  return kv;
}

// Stateful inner repo with spies, keyed for a single user (enough for these tests).
function innerRepo(initial: { ciphertext: string; clioRegion: string } | null) {
  const state = { rec: initial };
  const repo: ClioTokenRepo = {
    getConnection: vi.fn(async (_userId: string) => state.rec),
    saveConnection: vi.fn(async (rec) => { state.rec = { ciphertext: rec.ciphertext, clioRegion: rec.clioRegion }; }),
    updateTokens: vi.fn(async (_userId: string, ciphertext: string) => { if (state.rec) state.rec = { ...state.rec, ciphertext }; }),
  };
  return repo;
}

describe("kvCachedTokenRepo", () => {
  it("serves a second read from KV without hitting D1", async () => {
    const inner = innerRepo({ ciphertext: "ct", clioRegion: "EU" });
    const repo = kvCachedTokenRepo(fakeKv() as unknown as KVNamespace, inner);

    expect(await repo.getConnection("u")).toEqual({ ciphertext: "ct", clioRegion: "EU" });
    expect(await repo.getConnection("u")).toEqual({ ciphertext: "ct", clioRegion: "EU" });
    expect(inner.getConnection).toHaveBeenCalledTimes(1); // second read hit the cache
  });

  it("caches the populated entry under a per-user key with an expiry TTL", async () => {
    const inner = innerRepo({ ciphertext: "ct", clioRegion: "EU" });
    const kv = fakeKv();
    const repo = kvCachedTokenRepo(kv as unknown as KVNamespace, inner);

    await repo.getConnection("u-42");
    expect(kv.put).toHaveBeenCalledWith("clio-token:u-42", JSON.stringify({ ciphertext: "ct", clioRegion: "EU" }), {
      expirationTtl: expect.any(Number),
    });
  });

  it("does not cache a missing connection (so a fresh connect is seen immediately)", async () => {
    const inner = innerRepo(null);
    const kv = fakeKv();
    const repo = kvCachedTokenRepo(kv as unknown as KVNamespace, inner);

    expect(await repo.getConnection("u")).toBeNull();
    expect(kv.store.size).toBe(0);
  });

  it("invalidates the cache on updateTokens so the next read reflects the refreshed token", async () => {
    const inner = innerRepo({ ciphertext: "old", clioRegion: "EU" });
    const repo = kvCachedTokenRepo(fakeKv() as unknown as KVNamespace, inner);

    await repo.getConnection("u"); // caches "old"
    await repo.updateTokens("u", "new", 200, 100);
    expect(await repo.getConnection("u")).toEqual({ ciphertext: "new", clioRegion: "EU" });
    expect(inner.getConnection).toHaveBeenCalledTimes(2); // cache was invalidated, so D1 re-read
  });

  it("invalidates the cache on saveConnection (re-auth) so the new region/ciphertext is seen", async () => {
    const inner = innerRepo({ ciphertext: "old", clioRegion: "EU" });
    const repo = kvCachedTokenRepo(fakeKv() as unknown as KVNamespace, inner);

    await repo.getConnection("u"); // caches old EU entry
    await repo.saveConnection({ userId: "u", clioUserId: "1", clioRegion: "US", ciphertext: "new2", expiresAt: 1 });
    expect(await repo.getConnection("u")).toEqual({ ciphertext: "new2", clioRegion: "US" });
  });
});
