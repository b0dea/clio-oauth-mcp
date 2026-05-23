import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

const { mockAppendAuditLog, mockReadAuditLog } = vi.hoisted(() => ({
  mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
  mockReadAuditLog: vi.fn(),
}));

vi.mock("../../utils/auditLog.js", () => ({
  appendAuditLog: mockAppendAuditLog,
  readAuditLog: mockReadAuditLog,
}));

import { registerAuditExportTool } from "../auditExport.js";

const ENTRY_FIXTURE = {
  timestamp: "2024-06-15T12:00:00.000Z",
  session_id: "sess-1",
  tool: "list_matters",
  args: {},
  outcome: "success",
};

const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();

beforeAll(() => {
  const fakeServer = {
    registerTool: (name: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  };
  registerAuditExportTool(fakeServer as any);
});

beforeEach(() => {
  vi.clearAllMocks();
  mockAppendAuditLog.mockResolvedValue(undefined);
});

describe("export_audit_log", () => {
  it("returns entries and summary on success with no filters", async () => {
    mockReadAuditLog.mockResolvedValue({
      entries: [ENTRY_FIXTURE, ENTRY_FIXTURE],
      total_matched: 2,
      truncated: false,
    });
    const handler = handlers.get("export_audit_log")!;
    const result = await handler({ limit: 500, offset: 0 }) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.summary.total_matched).toBe(2);
    expect(parsed.summary.returned).toBe(2);
    expect(parsed.summary.truncated).toBe(false);
    expect(parsed.entries).toHaveLength(2);
    expect(result.isError).toBeUndefined();
  });

  it("calls appendAuditLog with outcome success and result_count", async () => {
    mockReadAuditLog.mockResolvedValue({ entries: [ENTRY_FIXTURE], total_matched: 1, truncated: false });
    const handler = handlers.get("export_audit_log")!;
    await handler({ limit: 500, offset: 0 });
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "export_audit_log", outcome: "success", result_count: 1 }),
    );
  });

  it("passes filters through to readAuditLog", async () => {
    mockReadAuditLog.mockResolvedValue({ entries: [], total_matched: 0, truncated: false });
    const handler = handlers.get("export_audit_log")!;
    await handler({ date_from: "2024-01-01", matter_id: 42, limit: 10, offset: 0 });
    expect(mockReadAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ date_from: "2024-01-01", matter_id: 42 }),
    );
  });

  it("includes next_offset and note in summary when results are truncated", async () => {
    mockReadAuditLog.mockResolvedValue({
      entries: Array(5).fill(ENTRY_FIXTURE),
      total_matched: 10,
      truncated: true,
    });
    const handler = handlers.get("export_audit_log")!;
    const result = await handler({ limit: 5, offset: 0 }) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.summary.truncated).toBe(true);
    expect(parsed.summary.next_offset).toBe(5);
    expect(parsed.summary.note).toMatch(/truncated/i);
  });

  it("returns isError and logs error outcome when readAuditLog rejects", async () => {
    mockReadAuditLog.mockRejectedValue(new Error("disk error"));
    const handler = handlers.get("export_audit_log")!;
    const result = await handler({ limit: 500, offset: 0 }) as any;
    expect(result.isError).toBe(true);
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "export_audit_log", outcome: "error", error_message: "disk error" }),
    );
  });
});
