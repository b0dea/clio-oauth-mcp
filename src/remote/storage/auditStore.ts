/**
 * Centralized, append-only audit sink (PRD §M5; "ABA Opinion 512" framing — see build-notes §9).
 * The 21 ported Clio tools call appendAuditLog on every success/error/not_found path; on the Worker
 * that resolves to upstream-shims/auditLog.ts, which forwards here through the per-request
 * SessionContext. D1 is the system of record — append-only: the AuditRepo seam only exposes
 * append(), and migrations/0003 installs DB triggers that abort any UPDATE/DELETE on audit_log.
 *
 * Redaction + row assembly (writeAuditEntry) is split from D1 I/O behind AuditRepo so it is
 * unit-tested with an in-memory double; d1AuditRepo is the thin SQL adapter (verified live). Same
 * shape as tokenStore.ts.
 */

import type { AuditEntry } from "../../utils/auditLog.js";

// Ported verbatim from the upstream fs-backed auditLog so the Worker redacts identically (the
// upstream module is fs/os-bound and aliased out of the Worker bundle, so we can't import it).
const REDACTED_KEYS = new Set([
  "access_token", "refresh_token", "client_secret", "password", "token", "encryption_key",
]);

/** Mask secret-named keys (recursively, objects only) before an args blob is persisted. */
export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (REDACTED_KEYS.has(k.toLowerCase())) {
      out[k] = "[REDACTED]";
    } else if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      out[k] = redactArgs(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * What a tool reports per call. This is exactly the upstream shim's parameter shape; `clio_user_id`
 * is omitted on purpose — identity is attached server-side from the authenticated props, never
 * trusted from the tool's entry (PRD §7).
 */
export type AuditEvent = Omit<AuditEntry, "timestamp" | "session_id" | "machine_ip" | "clio_user_id">;

/** Authenticated identity for the row — sourced from the access-token props, uninfluenceable by the caller. */
export interface AuditIdentity {
  userId: string;
  clioUserId?: string;
  sessionId: string;
}

/** A fully-assembled, redacted audit row ready to persist: the identity plus the redacted call. */
export interface AuditRow extends AuditIdentity {
  tool: string;
  args: Record<string, unknown>; // redacted
  outcome: AuditEntry["outcome"];
  errorMessage?: string;
  matterId?: number;
  resultCount?: number;
  createdAt: number; // epoch ms
}

export interface AuditRepo {
  /** Append one row. The seam exposes only append() — the table is append-only (migrations/0003). */
  append(row: AuditRow): Promise<void>;
}

// Clio API errors can fold in a raw response body; cap the stored message so one pathological error
// can't bloat a compliance row (the tool's own error response keeps the full text).
const ERROR_MESSAGE_MAX = 500;

/** Redact, stamp, and persist one tool-call audit row. The redaction + assembly are unit-tested. */
export async function writeAuditEntry(repo: AuditRepo, identity: AuditIdentity, event: AuditEvent): Promise<void> {
  await repo.append({
    userId: identity.userId,
    clioUserId: identity.clioUserId,
    sessionId: identity.sessionId,
    tool: event.tool,
    args: redactArgs(event.args),
    outcome: event.outcome,
    errorMessage: event.error_message?.slice(0, ERROR_MESSAGE_MAX),
    matterId: event.matter_id,
    resultCount: event.result_count,
    createdAt: Date.now(),
  });
}

/** D1-backed AuditRepo. Thin INSERT over audit_log (migrations/0002). Append-only — no UPDATE/DELETE. */
export function d1AuditRepo(db: D1Database): AuditRepo {
  return {
    async append(row) {
      await db
        .prepare(
          `INSERT INTO audit_log
             (user_id, clio_user_id, session_id, tool, args, outcome, error_message, matter_id, result_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          row.userId,
          row.clioUserId ?? null,
          row.sessionId,
          row.tool,
          JSON.stringify(row.args),
          row.outcome,
          row.errorMessage ?? null,
          row.matterId ?? null,
          row.resultCount ?? null,
          row.createdAt,
        )
        .run();
    },
  };
}
