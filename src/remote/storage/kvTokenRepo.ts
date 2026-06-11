/**
 * KV read-cache wrapping a ClioTokenRepo (D1) for the hot per-tool-call read path: every Clio API
 * call resolves the user's token, so without a cache each one is a D1 round-trip. KV is a cache
 * only — D1 stays the source of truth (build-notes §5: KV is eventually consistent ~60s, so it must
 * never serve a token we just wrote). The cached value is the encrypted ciphertext + region, never
 * a plaintext token, so the cache holds nothing sensitive in the clear.
 *
 * Writes invalidate the key: a refreshed/re-authorized token must not be shadowed by a stale cache
 * entry. Staleness is self-healing anyway — getValidClioToken refreshes on near-expiry, and that
 * refresh is a compare-and-set (tokenStore.ts), so a stale near-expiry ciphertext served during
 * KV's propagation window just triggers a benign re-refresh rather than handing back a dead token.
 */

import type { ClioTokenRepo } from "./tokenStore.js";

// Bounds how long KV and D1 can diverge after an out-of-band change; well under the 30-day token
// life, and writes invalidate eagerly, so this is just a backstop. KV's floor for expirationTtl.
const CACHE_TTL_SECONDS = 300;

const cacheKey = (userId: string) => `clio-token:${userId}`;

export function kvCachedTokenRepo(
  kv: KVNamespace,
  inner: ClioTokenRepo,
  ttlSeconds: number = CACHE_TTL_SECONDS,
): ClioTokenRepo {
  return {
    async getConnection(userId) {
      const cached = await kv.get(cacheKey(userId));
      if (cached !== null) return JSON.parse(cached) as { ciphertext: string; clioRegion: string };

      const rec = await inner.getConnection(userId);
      // Don't cache a miss: a user who connects right after should be seen without waiting out a TTL.
      if (rec) await kv.put(cacheKey(userId), JSON.stringify(rec), { expirationTtl: ttlSeconds });
      return rec;
    },

    async saveConnection(rec) {
      await inner.saveConnection(rec);
      await kv.delete(cacheKey(rec.userId)); // next read repopulates with the new ciphertext + region
    },

    async updateTokens(userId, ciphertext, expiresAt, prevExpiresAt) {
      await inner.updateTokens(userId, ciphertext, expiresAt, prevExpiresAt);
      await kv.delete(cacheKey(userId)); // never serve the pre-refresh ciphertext from cache
    },
  };
}
