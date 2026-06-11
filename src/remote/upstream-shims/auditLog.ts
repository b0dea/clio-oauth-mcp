/**
 * Worker replacement for the upstream audit log (src/utils/auditLog.ts), swapped in by the wrangler
 * `alias` map for the Worker build only (the stdio build keeps the real module). The original
 * appends JSONL to `~/.clio-mcp/audit.log` via `fs` and reads `os.homedir()`/`os.networkInterfaces()`
 * at module load — none of which works on Workers.
 *
 * The 21 ported tools call appendAuditLog on every action, so it has to exist with the same
 * signature — but it is a deliberate **no-op**: the pilot hosts no audit/connection log (operator
 * decision). A D1 sink (M5) was built then removed; if audit logging is wanted later, wire it behind
 * this function (see git history, commit aa46fe4) — no tool edits needed.
 */

// Reuse the upstream entry shape so this stays a faithful drop-in (type-only import — erased at
// bundle, so it doesn't pull the real fs-backed module back in).
import type { AuditEntry } from "../../utils/auditLog.js";

export async function appendAuditLog(
  _entry: Omit<AuditEntry, "timestamp" | "session_id" | "machine_ip">,
): Promise<void> {
  // Intentionally does nothing — no audit log is persisted for the pilot.
}
