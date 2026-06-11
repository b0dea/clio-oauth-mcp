import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildMcpServer, PING_PAYLOAD, type AuthContext } from "../server.js";

// Exercise the real MCP request path: a Client talking to buildMcpServer() over a
// linked in-memory transport. No mocks of the server under test.
async function connectedClient(auth?: AuthContext): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "m2-test", version: "0.0.0" });
  await Promise.all([
    buildMcpServer(auth).connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

function pingPayload(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content as Array<{ type: string; text: string }>;
  expect(content).toHaveLength(1);
  expect(content[0].type).toBe("text");
  return JSON.parse(content[0].text);
}

describe("MCP server", () => {
  it("exposes exactly one tool, clio_ping, annotated read-only", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name)).toEqual(["clio_ping"]);
    expect(tools[0].description).toBeTruthy();
    expect(tools[0].annotations?.readOnlyHint).toBe(true);
  });

  it("clio_ping returns the static payload with a null user when unauthenticated", async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: "clio_ping" });

    expect(result.isError ?? false).toBe(false);
    expect(pingPayload(result)).toEqual({ ...PING_PAYLOAD, authenticatedUser: null });
  });

  // The props seam (build-notes §10 spike #1): workers-oauth-provider decrypts the
  // grant props onto ctx.props and the api handler injects them here. Proving clio_ping
  // echoes the injected identity proves M4 can inject the per-user Clio client the same way.
  it("clio_ping echoes the authenticated user from the injected context", async () => {
    const client = await connectedClient({ userId: "user-abc" });
    const result = await client.callTool({ name: "clio_ping" });

    expect(pingPayload(result).authenticatedUser).toBe("user-abc");
  });
});
