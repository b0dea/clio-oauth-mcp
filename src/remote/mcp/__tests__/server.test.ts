import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildMcpServer, PING_PAYLOAD } from "../server.js";

// Exercise the real MCP request path: a Client talking to buildMcpServer() over a
// linked in-memory transport. No mocks of the server under test.
async function connectedClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "m1-test", version: "0.0.0" });
  await Promise.all([
    buildMcpServer().connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

describe("M1 MCP server", () => {
  it("exposes exactly one tool, clio_ping, annotated read-only", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name)).toEqual(["clio_ping"]);
    expect(tools[0].description).toBeTruthy();
    expect(tools[0].annotations?.readOnlyHint).toBe(true);
  });

  it("clio_ping returns the static payload as JSON text", async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: "clio_ping" });

    expect(result.isError ?? false).toBe(false);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(JSON.parse(content[0].text)).toEqual(PING_PAYLOAD);
  });
});
