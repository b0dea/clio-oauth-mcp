import { describe, it, expect } from "vitest";
import {
  redactArgs,
  writeAuditEntry,
  d1AuditRepo,
  type AuditRepo,
  type AuditRow,
} from "../auditStore.js";

// In-memory AuditRepo — the legitimate storage boundary (same shape as tokenStore's memoryRepo).
// The D1 SQL adapter is a thin implementation verified live; here we exercise redaction + the row
// assembly for real.
function memoryRepo(): AuditRepo & { rows: AuditRow[] } {
  const rows: AuditRow[] = [];
  return { rows, async append(row) { rows.push(row); } };
}

const identity = { userId: "clio-7", clioUserId: "7", sessionId: "clio-7" };

describe("redactArgs", () => {
  it("masks every secret-named key (case-insensitive)", () => {
    const out = redactArgs({
      access_token: "a", refresh_token: "r", client_secret: "c",
      password: "p", token: "t", encryption_key: "k", ACCESS_TOKEN: "A",
    });
    expect(out).toEqual({
      access_token: "[REDACTED]", refresh_token: "[REDACTED]", client_secret: "[REDACTED]",
      password: "[REDACTED]", token: "[REDACTED]", encryption_key: "[REDACTED]", ACCESS_TOKEN: "[REDACTED]",
    });
  });

  it("leaves non-secret fields untouched", () => {
    expect(redactArgs({ matter_id: 42, status: "open", limit: 10 })).toEqual({
      matter_id: 42, status: "open", limit: 10,
    });
  });

  it("recurses into nested objects", () => {
    expect(redactArgs({ outer: { token: "secret", keep: "v" } })).toEqual({
      outer: { token: "[REDACTED]", keep: "v" },
    });
  });

  it("does not recurse into arrays (faithful to the upstream impl)", () => {
    const arr = [{ token: "secret" }];
    expect(redactArgs({ items: arr })).toEqual({ items: arr });
  });
});

describe("writeAuditEntry", () => {
  it("redacts args before they are persisted", async () => {
    const repo = memoryRepo();
    await writeAuditEntry(repo, identity, {
      tool: "create_matter",
      args: { description: "Smith v Jones", access_token: "leak-me" },
      outcome: "success",
    });
    expect(repo.rows[0].args).toEqual({ description: "Smith v Jones", access_token: "[REDACTED]" });
    expect(JSON.stringify(repo.rows[0])).not.toContain("leak-me");
  });

  it("attaches the authenticated identity and maps the tool fields onto the row", async () => {
    const repo = memoryRepo();
    await writeAuditEntry(repo, identity, {
      tool: "list_matters",
      args: { status: "open", limit: 10 },
      outcome: "success",
      result_count: 3,
      matter_id: 99,
    });
    const row = repo.rows[0];
    expect(row).toMatchObject({
      userId: "clio-7", clioUserId: "7", sessionId: "clio-7",
      tool: "list_matters", outcome: "success", resultCount: 3, matterId: 99,
    });
    expect(typeof row.createdAt).toBe("number");
    expect(row.createdAt).toBeGreaterThan(0);
  });

  it("carries the error_message through on a failed call", async () => {
    const repo = memoryRepo();
    await writeAuditEntry(repo, identity, {
      tool: "get_matter", args: { matter_id: 5 }, outcome: "error", error_message: "Clio 500", matter_id: 5,
    });
    expect(repo.rows[0]).toMatchObject({ outcome: "error", errorMessage: "Clio 500", matterId: 5 });
  });

  it("caps a very long error_message so one bad error can't bloat a row", async () => {
    const repo = memoryRepo();
    await writeAuditEntry(repo, identity, {
      tool: "get_matter", args: {}, outcome: "error", error_message: "x".repeat(5000),
    });
    expect(repo.rows[0].errorMessage).toHaveLength(500);
  });

  it("sources user_id from the authenticated identity, never from the tool args", async () => {
    // A tool arg that looks like an identity must not become the row's user_id — attribution is
    // the authenticated subject only (PRD §7).
    const repo = memoryRepo();
    await writeAuditEntry(repo, identity, {
      tool: "list_matters",
      args: { user_id: "clio-OTHER", clio_user_id: "999" },
      outcome: "success",
    });
    expect(repo.rows[0].userId).toBe("clio-7");
    expect(repo.rows[0].clioUserId).toBe("7");
  });

  it("attributes each call to its own identity (per-user isolation)", async () => {
    const repo = memoryRepo();
    await writeAuditEntry(repo, { userId: "clio-a", clioUserId: "1", sessionId: "clio-a" },
      { tool: "list_matters", args: {}, outcome: "success" });
    await writeAuditEntry(repo, { userId: "clio-b", clioUserId: "2", sessionId: "clio-b" },
      { tool: "list_matters", args: {}, outcome: "success" });
    expect(repo.rows.map((r) => r.userId)).toEqual(["clio-a", "clio-b"]);
  });
});

describe("d1AuditRepo", () => {
  // Minimal D1 fake: record the prepared SQL and the bound params, so we can assert the adapter is
  // append-only (a single INSERT, no UPDATE/DELETE) and binds the columns in order.
  function fakeD1() {
    const calls: { sql: string; params: unknown[] }[] = [];
    const db = {
      prepare(sql: string) {
        const call = { sql, params: [] as unknown[] };
        calls.push(call);
        return {
          bind(...params: unknown[]) { call.params = params; return this; },
          async run() { return { success: true }; },
        };
      },
    };
    return { db: db as unknown as D1Database, calls };
  }

  const row: AuditRow = {
    userId: "clio-7", clioUserId: "7", sessionId: "clio-7",
    tool: "create_matter", args: { description: "x", access_token: "[REDACTED]" },
    outcome: "success", matterId: 12, resultCount: undefined, createdAt: 1_700_000_000_000,
  };

  it("appends with a single INSERT — never UPDATE or DELETE (append-only)", async () => {
    const { db, calls } = fakeD1();
    await d1AuditRepo(db).append(row);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/^\s*INSERT INTO audit_log/i);
    expect(calls[0].sql).not.toMatch(/UPDATE|DELETE/i);
  });

  it("binds the columns in order and serializes args to JSON", async () => {
    const { db, calls } = fakeD1();
    await d1AuditRepo(db).append(row);
    expect(calls[0].params).toEqual([
      "clio-7", "7", "clio-7", "create_matter",
      JSON.stringify({ description: "x", access_token: "[REDACTED]" }),
      "success", null, 12, null, 1_700_000_000_000,
    ]);
  });
});
