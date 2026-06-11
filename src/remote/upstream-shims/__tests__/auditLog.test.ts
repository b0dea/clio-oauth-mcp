import { describe, it, expect, vi } from "vitest";
import { appendAuditLog } from "../auditLog.js";
import { sessionStorage } from "../../../utils/sessionContext.js";
import { buildClioSessionContext, type AuditWriter } from "../../adapter/sessionContext.js";
import { writeAuditEntry, type AuditRepo, type AuditRow } from "../../storage/auditStore.js";

// The shim resolves to ../utils/auditLog.js in the Worker bundle (wrangler alias) and is what the 21
// ported tools call. These tests drive the real shim through the real AsyncLocalStorage seam, with
// an in-memory audit repo behind the injected write closure — proving the per-request injection and
// the non-fatal guarantee end-to-end (no Clio, no D1).

function memoryRepo(): AuditRepo & { rows: AuditRow[] } {
  const rows: AuditRow[] = [];
  return { rows, async append(row) { rows.push(row); } };
}

const identity = { userId: "clio-7", clioUserId: "7", sessionId: "clio-7" };

function ctxWith(appendAudit?: AuditWriter) {
  return buildClioSessionContext("clio-7", async () => "tok", appendAudit);
}

describe("appendAuditLog (Worker shim)", () => {
  it("persists a redacted row through the per-request audit writer on the SessionContext", async () => {
    const repo = memoryRepo();
    const ctx = ctxWith((event) => writeAuditEntry(repo, identity, event));
    await sessionStorage.run(ctx, () =>
      appendAuditLog({ tool: "list_matters", args: { status: "open", access_token: "leak" }, outcome: "success", result_count: 2 }),
    );
    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0]).toMatchObject({ userId: "clio-7", tool: "list_matters", outcome: "success", resultCount: 2 });
    expect(repo.rows[0].args).toEqual({ status: "open", access_token: "[REDACTED]" });
  });

  it("is non-fatal: a failing audit write never throws into the tool call and writes no row", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    // A repo whose append rejects (e.g. D1 down): the tool call must still resolve, and the failed
    // write must leave no row behind.
    const repo: AuditRepo & { rows: AuditRow[] } = { rows: [], async append() { throw new Error("D1 unavailable"); } };
    const ctx = ctxWith((event) => writeAuditEntry(repo, identity, event));
    await expect(
      sessionStorage.run(ctx, () => appendAuditLog({ tool: "get_matter", args: {}, outcome: "success" })),
    ).resolves.toBeUndefined();
    expect(repo.rows).toHaveLength(0);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("no-ops when the SessionContext carries no audit writer", async () => {
    const ctx = ctxWith(undefined);
    await expect(
      sessionStorage.run(ctx, () => appendAuditLog({ tool: "get_matter", args: {}, outcome: "success" })),
    ).resolves.toBeUndefined();
  });

  it("no-ops (no throw) when there is no SessionContext at all", async () => {
    await expect(appendAuditLog({ tool: "get_matter", args: {}, outcome: "success" })).resolves.toBeUndefined();
  });
});
