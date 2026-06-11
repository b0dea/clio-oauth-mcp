/**
 * Leg-2 (us -> Clio) CSRF protection. We can't carry the Leg-1 authorization request through
 * Clio's login as query state without trusting/​sizing a signed blob, so we mint a random,
 * single-use `state`, stash the Leg-1 AuthRequest in D1 against it, and resume on /clio/callback.
 *
 * D1 (not KV) on purpose: the write at /authorize and the read at /clio/callback can be seconds
 * apart, inside KV's ~60s eventual-consistency window — a miss there would break the flow. The
 * state is unguessable (CSRF), single-use (consumed = deleted, so a replayed callback fails), and
 * expiring.
 */

import type { AuthRequest } from "@cloudflare/workers-oauth-provider";

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export interface PendingAuthRepo {
  put(state: string, authReqJson: string, expiresAt: number): Promise<void>;
  /** Read-and-delete (single-use). Returns the row or null if the state is unknown. */
  take(state: string): Promise<{ authReqJson: string; expiresAt: number } | null>;
}

function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

export async function createPendingAuth(
  repo: PendingAuthRepo,
  authReq: AuthRequest,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<string> {
  const state = randomState();
  await repo.put(state, JSON.stringify(authReq), Date.now() + ttlMs);
  return state;
}

export async function consumePendingAuth(repo: PendingAuthRepo, state: string): Promise<AuthRequest | null> {
  const row = await repo.take(state);
  if (!row || row.expiresAt < Date.now()) return null;
  return JSON.parse(row.authReqJson) as AuthRequest;
}

/** D1-backed PendingAuthRepo over the pending_auth table (migrations/0001). */
export function d1PendingAuthRepo(db: D1Database): PendingAuthRepo {
  return {
    async put(state, authReqJson, expiresAt) {
      // Opportunistically GC expired rows on each write — low traffic, keeps the table small.
      await db.batch([
        db.prepare(`DELETE FROM pending_auth WHERE expires_at < ?`).bind(Date.now()),
        db
          .prepare(`INSERT INTO pending_auth (state, auth_req, expires_at) VALUES (?, ?, ?)`)
          .bind(state, authReqJson, expiresAt),
      ]);
    },
    async take(state) {
      return db
        .prepare(`DELETE FROM pending_auth WHERE state = ? RETURNING auth_req AS authReqJson, expires_at AS expiresAt`)
        .bind(state)
        .first<{ authReqJson: string; expiresAt: number }>();
    },
  };
}
