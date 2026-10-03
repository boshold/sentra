import { createServer } from "node:http";

import { createSentra, memoryStorage } from "@bosdev/sentra-core";

import { createMcpRoute } from "#src/mcp.js";

import { httpRequest, parseJson } from "./http.js";

vi.mock("@modelcontextprotocol/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@modelcontextprotocol/server")>();
  return {
    ...actual,
    createMcpHandler: () => ({
      fetch: async () => {
        throw new Error("sdk boom");
      },
      close: async () => undefined,
    }),
  };
});

describe("createMcpRoute errors", () => {
  it("maps SDK handler failures to a JSON-RPC 500", async () => {
    const sentra = await createSentra({ storage: memoryStorage() });
    const errors: string[] = [];
    const route = createMcpRoute({
      sentra,
      version: "1.0.0",
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: (text) => errors.push(text),
      },
    });
    const server = createServer((req, res) => {
      void route.listener(req, res);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const port = address !== null && typeof address === "object" ? address.port : 0;
    try {
      const result = await httpRequest(port, { method: "POST", path: "/mcp", body: "{}" });
      expect(result.status).toBe(500);
      expect(parseJson(result.body)).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32_603, message: "Internal error" },
      });
      expect(result.body).not.toContain("boom");
      expect(errors).toEqual([expect.stringContaining("sdk boom")]);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      await route.close();
      await sentra.close();
    }
  });
});
