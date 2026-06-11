/**
 * Worker replacement for the upstream audit log (src/utils/auditLog.ts), swapped in by the wrangler
 * `alias` map for the Worker build only (the stdio build keeps the real module). The original
 * appends JSONL to `~/.clio-mcp/audit.log` via `fs` and reads `os.homedir()`/`os.networkInterfaces()`
 * at module load — none of which works on Workers.
 *
 * For M4 the ported tools call appendAuditLog on every action, so it has to exist with the same
 * signature, but it is a no-op here: the centralized, append-only D1 audit log is M5. M5 fills in
 * the D1 sink behind this same function — no tool edits.
 */

// Reuse the upstream entry shape so this stays a faithful drop-in (type-only import — erased at
// bundle, so it doesn't pull the real fs-backed module back in).
import type { AuditEntry } from "../../utils/auditLog.js";

export async function appendAuditLog(
  _entry: Omit<AuditEntry, "timestamp" | "session_id" | "machine_ip">,
): Promise<void> {
  // No-op until M5 wires the D1 audit sink here.
}
