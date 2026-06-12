import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildMcpServer, PING_PAYLOAD, type McpDeps, type WhoamiResult } from "../server.js";

const WHOAMI: WhoamiResult = {
  clioUserId: "42",
  name: "Ada Lovelace",
  email: "ada@firm.example",
  tokenExpiresInMinutes: 4321,
};

function deps(overrides?: Partial<McpDeps>): McpDeps {
  return {
    auth: { userId: "clio-42", clioUserId: "42" },
    whoami: async () => WHOAMI,
    ...overrides,
  };
}

async function connectedClient(d?: McpDeps): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "m3-test", version: "0.0.0" });
  await Promise.all([
    buildMcpServer(d).connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

function payload(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content as Array<{ type: string; text: string }>;
  expect(content[0].type).toBe("text");
  return JSON.parse(content[0].text);
}

describe("MCP server", () => {
  it("read-only by default: exposes clio_ping, clio_whoami, and the 13 read tools (no writes)", async () => {
    const client = await connectedClient(deps());
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toHaveLength(15); // ping + whoami + 13 reads
    expect(names.every((n) => n.startsWith("clio_"))).toBe(true);
    expect(names).toEqual(expect.arrayContaining(["clio_ping", "clio_whoami", "clio_list_matters"]));
    expect(names).not.toContain("clio_create_matter");
    expect(names).not.toContain("clio_upload_document");
  });

  it("write-enabled (V1_WRITE_SCOPE=all): also exposes the write tools — 23 total", async () => {
    const client = await connectedClient(deps({ writeEnabled: true }));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toHaveLength(23); // ping + whoami + 21 (upload_document is remote-incompatible)
    expect(names).toEqual(expect.arrayContaining(["clio_create_matter", "clio_update_task"]));
    expect(names).not.toContain("clio_upload_document");
  });

  it("annotates ping/whoami read-only and (when enabled) write tools as writes", async () => {
    const client = await connectedClient(deps({ writeEnabled: true }));
    const ann = Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t.annotations]));
    expect(ann["clio_ping"]?.readOnlyHint).toBe(true);
    expect(ann["clio_whoami"]?.readOnlyHint).toBe(true);
    expect(ann["clio_create_matter"]?.readOnlyHint).toBe(false);
  });

  it("clio_ping echoes the authenticated user from the injected context", async () => {
    const client = await connectedClient(deps());
    expect(payload(await client.callTool({ name: "clio_ping" })).authenticatedUser).toBe("clio-42");
  });

  it("clio_ping reports a null user when built without an injected context", async () => {
    const client = await connectedClient();
    expect(payload(await client.callTool({ name: "clio_ping" }))).toEqual({ ...PING_PAYLOAD, authenticatedUser: null });
  });

  it("clio_whoami returns the connected Clio identity and token expiry", async () => {
    const client = await connectedClient(deps());
    expect(payload(await client.callTool({ name: "clio_whoami" }))).toEqual({
      clio_user_id: "42",
      name: "Ada Lovelace",
      email: "ada@firm.example",
      token_expires_in_minutes: 4321,
    });
  });

  it("clio_whoami surfaces an error when the user is not connected", async () => {
    const client = await connectedClient(
      deps({
        whoami: async () => {
          throw new Error('User "clio-42" is not connected to Clio');
        },
      }),
    );
    const result = await client.callTool({ name: "clio_whoami" });
    expect(result.isError).toBe(true);
  });
});
