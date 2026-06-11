/**
 * Worker replacement for the upstream audit log (src/utils/auditLog.ts), swapped in by the wrangler
 * `alias` map for the Worker build only (the stdio build keeps the real module). The original
 * appends JSONL to `~/.clio-mcp/audit.log` via `fs` and reads `os.homedir()`/`os.networkInterfaces()`
 * at module load — none of which works on Workers.
 *
 * M5 sink: the 21 ported tools call appendAuditLog on every action; here we forward to the
 * per-request audit writer attached to the SessionContext (the same AsyncLocalStorage seam the
 * token uses). The writer is bound to {env.DB, userId, clioUserId} in mcp/api.ts — the shim has no
 * access to env or the user identity on its own. The write is awaited (durable: the row lands
 * before the tool returns) but best-effort: any failure is caught and logged, never thrown into the
 * tool call (PRD §M5 — a broken audit write must not break a Clio action).
 */

// Type-only imports — erased at bundle, so they don't pull the real fs-backed module back in.
import type { AuditEntry } from "../../utils/auditLog.js";
import type { ClioSessionContext } from "../adapter/sessionContext.js";
import { getSessionContext } from "../../utils/sessionContext.js";

export async function appendAuditLog(
  entry: Omit<AuditEntry, "timestamp" | "session_id" | "machine_ip">,
): Promise<void> {
  try {
    const ctx = getSessionContext() as ClioSessionContext | undefined;
    if (!ctx?.appendAudit) return; // no writer wired (e.g. outside an authenticated /mcp turn) — non-fatal
    await ctx.appendAudit(entry);
  } catch (err) {
    // Log the tool name (not the args) so a write failure is visible without leaking entry contents.
    console.error(`[audit] write failed for tool "${entry.tool}": ${err instanceof Error ? err.message : String(err)}`);
  }
}
