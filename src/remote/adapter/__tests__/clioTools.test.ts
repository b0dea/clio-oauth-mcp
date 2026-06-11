import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { withClioToolPrefix, registerClioDataTools, CLIO_TOOL_ANNOTATIONS } from "../clioTools.js";

// Spy server capturing what reaches the underlying McpServer.registerTool.
function spyServer() {
  const calls: Array<{ name: string; config: any }> = [];
  const server = {
    registerTool: (name: string, config: any, _cb: unknown) => calls.push({ name, config }),
  } as unknown as McpServer;
  return { server, calls };
}

describe("withClioToolPrefix", () => {
  it("prefixes the tool name with clio_ and passes description/schema through", () => {
    const { server, calls } = spyServer();
    withClioToolPrefix(server).registerTool(
      "list_matters",
      { description: "List matters", inputSchema: {} },
      async () => ({ content: [] }),
    );
    expect(calls[0].name).toBe("clio_list_matters");
    expect(calls[0].config.description).toBe("List matters");
  });

  it("merges read annotations for a read tool", () => {
    const { server, calls } = spyServer();
    withClioToolPrefix(server).registerTool("get_matter", { description: "d" }, async () => ({ content: [] }));
    expect(calls[0].config.annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
  });

  it("merges create annotations (non-destructive write) for an additive create tool", () => {
    const { server, calls } = spyServer();
    withClioToolPrefix(server).registerTool("create_matter", { description: "d" }, async () => ({ content: [] }));
    expect(calls[0].config.annotations).toEqual({
      readOnlyHint: false,
      openWorldHint: true,
      idempotentHint: false,
      destructiveHint: false,
    });
  });

  it("merges destructive annotations for a state-mutating write tool", () => {
    const { server, calls } = spyServer();
    withClioToolPrefix(server).registerTool("update_task", { description: "d" }, async () => ({ content: [] }));
    expect(calls[0].config.annotations).toEqual({
      readOnlyHint: false,
      openWorldHint: true,
      idempotentHint: false,
      destructiveHint: true,
    });
  });

  it("still prefixes an unknown tool but adds no annotations", () => {
    const { server, calls } = spyServer();
    withClioToolPrefix(server).registerTool("future_tool", { description: "d" }, async () => ({ content: [] }));
    expect(calls[0].name).toBe("clio_future_tool");
    expect(calls[0].config.annotations).toBeUndefined();
  });

  it("drops a remote-incompatible tool entirely (upload_document needs local filesystem access)", () => {
    const { server, calls } = spyServer();
    withClioToolPrefix(server).registerTool("upload_document", { description: "d" }, async () => ({ content: [] }));
    expect(calls).toHaveLength(0);
  });
});

describe("CLIO_TOOL_ANNOTATIONS", () => {
  it("covers exactly the 21 registered data tools (upload_document is remote-incompatible)", () => {
    expect(Object.keys(CLIO_TOOL_ANNOTATIONS).sort()).toEqual(
      [
        "create_activity", "create_calendar_entry", "create_matter", "create_note", "create_task",
        "complete_task", "get_billing_summary", "get_contact", "get_document", "get_matter", "get_user",
        "list_calendar_entries", "list_calendars", "list_documents", "list_matters", "list_tasks",
        "list_time_entries", "list_users", "log_time_entry", "search_contacts", "update_task",
      ].sort(),
    );
  });
});

describe("registerClioDataTools (real MCP server)", () => {
  async function listed() {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerClioDataTools(server);
    const client = new Client({ name: "t", version: "0.0.0" });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    return (await client.listTools()).tools;
  }

  it("registers 21 data tools (upload_document excluded), every name clio_-prefixed", async () => {
    const tools = await listed();
    expect(tools).toHaveLength(21);
    expect(tools.map((t) => t.name)).not.toContain("clio_upload_document");
    expect(tools.every((t) => t.name.startsWith("clio_"))).toBe(true);
  });

  it("annotates read vs create vs mutate tools per PRD §M4", async () => {
    const byName = Object.fromEntries((await listed()).map((t) => [t.name, t.annotations]));
    expect(byName["clio_list_matters"]).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    expect(byName["clio_create_task"]).toMatchObject({ readOnlyHint: false, openWorldHint: true, idempotentHint: false, destructiveHint: false });
    expect(byName["clio_complete_task"]).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
  });
});
