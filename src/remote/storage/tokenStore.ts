/**
 * Per-user Clio token store. D1 is the source of truth (read-your-writes — matters for refresh
 * races; KV's ~60s eventual consistency would risk handing back a stale token right after a
 * refresh). Tokens live as AES-256-GCM ciphertext (storage/crypto.ts); only the per-user `userId`
 * keys a lookup, so no code path can reach another user's token (PRD §7 top invariant).
 *
 * The refresh/decrypt orchestration is split from D1 I/O behind ClioTokenRepo so it is unit-tested
 * against real crypto with an in-memory repo; d1TokenRepo is the thin SQL adapter (verified live).
 * A KV read-cache can wrap this repo in M4 when the per-tool-call read path gets hot.
 */

import { decrypt, encrypt } from "./crypto.js";
import type { ClioTokenSet } from "../clio/oauth.js";

export interface ClioTokenRepo {
  /** Token ciphertext + the user's region, or null if not connected. */
  getConnection(userId: string): Promise<{ ciphertext: string; clioRegion: string } | null>;
  /** Connect-time upsert of both identity (users) and token (clio_tokens) rows. */
  saveConnection(rec: {
    userId: string;
    clioUserId: string;
    clioRegion: string;
    name?: string;
    email?: string;
    ciphertext: string;
    expiresAt: number;
  }): Promise<void>;
  /**
   * Refresh-time update of just the token row (identity columns are untouched). Conditional on
   * `prevExpiresAt`: the write only lands if the stored expiry still matches the one the caller
   * read, so two requests that concurrently refresh the same near-expiry token don't double-write
   * (the second is a no-op). Clio refresh tokens are non-rotating, so either refreshed token is
   * valid — this just keeps the write a clean compare-and-set instead of a lost update.
   */
  updateTokens(userId: string, ciphertext: string, expiresAt: number, prevExpiresAt: number): Promise<void>;
}

export interface ClioConnectionIdentity {
  userId: string;
  clioUserId: string;
  clioRegion: string;
  name?: string;
  email?: string;
}

// Refresh when the access token is within this window of expiry (or already past it).
const REFRESH_SKEW_MS = 5 * 60 * 1000;

/** Encrypt and persist a brand-new (or re-authorized) Clio connection for a user. */
export async function saveClioConnection(
  repo: ClioTokenRepo,
  encryptionKey: string,
  identity: ClioConnectionIdentity,
  tokens: ClioTokenSet,
): Promise<void> {
  const ciphertext = await encrypt(encryptionKey, JSON.stringify(tokens));
  await repo.saveConnection({ ...identity, ciphertext, expiresAt: tokens.expiresAt });
}

/**
 * Resolve a usable Clio access token for a user: decrypt the stored set, transparently refresh
 * (and persist) if it is near expiry, and return the token plus the user's region for routing.
 * Throws if the user has no stored connection.
 */
export async function getValidClioToken(
  repo: ClioTokenRepo,
  encryptionKey: string,
  refresh: (region: string, refreshToken: string) => Promise<ClioTokenSet>,
  userId: string,
): Promise<{ accessToken: string; region: string; expiresAt: number }> {
  const rec = await repo.getConnection(userId);
  if (!rec) {
    throw new Error(`User "${userId}" is not connected to Clio`);
  }
  const tokens = JSON.parse(await decrypt(encryptionKey, rec.ciphertext)) as ClioTokenSet;

  if (tokens.expiresAt - Date.now() > REFRESH_SKEW_MS) {
    return { accessToken: tokens.accessToken, region: rec.clioRegion, expiresAt: tokens.expiresAt };
  }

  const refreshed = await refresh(rec.clioRegion, tokens.refreshToken);
  // `tokens.expiresAt` is the expiry we read and decided to refresh on — the compare-and-set key.
  await repo.updateTokens(userId, await encrypt(encryptionKey, JSON.stringify(refreshed)), refreshed.expiresAt, tokens.expiresAt);
  return { accessToken: refreshed.accessToken, region: rec.clioRegion, expiresAt: refreshed.expiresAt };
}

/** D1-backed ClioTokenRepo. Thin SQL over the users + clio_tokens tables (migrations/0001). */
export function d1TokenRepo(db: D1Database): ClioTokenRepo {
  return {
    async getConnection(userId) {
      return db
        .prepare(
          `SELECT t.ciphertext AS ciphertext, u.clio_region AS clioRegion
             FROM clio_tokens t JOIN users u ON u.user_id = t.user_id
            WHERE t.user_id = ?`,
        )
        .bind(userId)
        .first<{ ciphertext: string; clioRegion: string }>();
    },
    async saveConnection(rec) {
      const now = Date.now();
      await db.batch([
        db
          .prepare(
            `INSERT INTO users (user_id, clio_user_id, clio_region, name, email, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET
               clio_user_id = excluded.clio_user_id,
               clio_region  = excluded.clio_region,
               name         = excluded.name,
               email        = excluded.email,
               updated_at   = excluded.updated_at`,
          )
          .bind(rec.userId, rec.clioUserId, rec.clioRegion, rec.name ?? null, rec.email ?? null, now, now),
        db
          .prepare(
            `INSERT INTO clio_tokens (user_id, ciphertext, expires_at, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET
               ciphertext = excluded.ciphertext,
               expires_at = excluded.expires_at,
               updated_at = excluded.updated_at`,
          )
          .bind(rec.userId, rec.ciphertext, rec.expiresAt, now),
      ]);
    },
    async updateTokens(userId, ciphertext, expiresAt, prevExpiresAt) {
      // Compare-and-set: only overwrite if the row still holds the expiry we refreshed from, so a
      // concurrent refresh of the same token is a no-op rather than a lost update.
      await db
        .prepare(`UPDATE clio_tokens SET ciphertext = ?, expires_at = ?, updated_at = ? WHERE user_id = ? AND expires_at = ?`)
        .bind(ciphertext, expiresAt, Date.now(), userId, prevExpiresAt)
        .run();
    },
  };
}
