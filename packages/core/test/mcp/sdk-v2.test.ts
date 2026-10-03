import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";

import type { Sentra } from "#src/index.js";

import { seededSentra } from "./helpers.js";
import { toolCalls } from "./sdk-cases.js";

function register(server: McpServer, sentra: Sentra): void {
  for (const t of sentra.mcpTools()) {
    server.registerTool(
      t.name,
      {
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: t.annotations,
      },
      async (args) => t.handler(args),
    );
  }
}

describe("MCP SDK v2 host", () => {
  let sentra: Sentra;
  let client: Client;
  let server: McpServer;

  beforeAll(async () => {
    sentra = await seededSentra();
    server = new McpServer({ name: "sentra-test", version: "1.0.0" });
    register(server, sentra);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "client", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
    await sentra.close();
  });

  it("lists five tools with object JSON schemas", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(sentra.mcpTools().map((tool) => tool.name));
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });

  it("calls every tool", async () => {
    for (const call of await toolCalls(sentra)) {
      const result = await client.callTool(call);
      expect(result.isError ?? false).toBe(false);
      expect(result.content).toEqual([{ type: "text", text: expect.any(String) }]);
    }
  });

  it("returns tool errors for invalid input", async () => {
    const result = await client.callTool({ name: "sentra_get_issue", arguments: { id: "x" } });
    expect(result.isError).toBe(true);
  });
});
