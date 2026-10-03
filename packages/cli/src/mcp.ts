import type { IncomingMessage, ServerResponse } from "node:http";

import { toNodeListener } from "@bosdev/sentra-core";
import type { Sentra, SentraLogger } from "@bosdev/sentra-core";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";

import { sendJson } from "#src/router.js";
import type { NodeListener } from "#src/router.js";

interface McpRoute {
  listener: NodeListener;
  /** Closes the SDK handler. */
  close(): Promise<void>;
}

function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  sendJson(res, status, { jsonrpc: "2.0", id: null, error: { code: -32_000, message } }, headers);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createMcpRoute(deps: { sentra: Sentra; version: string; logger: SentraLogger }): McpRoute {
  const { sentra, version, logger } = deps;
  const tools = sentra.mcpTools();

  function createServer(): McpServer {
    const server = new McpServer({ name: "sentra", version });
    for (const t of tools) {
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
    return server;
  }

  const handler = createMcpHandler(createServer, {
    onerror: (error) => {
      logger.debug(`mcp: ${error.message}`);
    },
  });
  async function fetchOrFail(request: Request): Promise<Response> {
    try {
      return await handler.fetch(request);
    } catch (error) {
      logger.error(`mcp request failed: ${messageOf(error)}`, { error });
      return Response.json(
        { jsonrpc: "2.0", id: null, error: { code: -32_603, message: "Internal error" } },
        { status: 500 },
      );
    }
  }

  async function serve(request: Request): Promise<Response> {
    // Stateless endpoint: client session ids are meaningless here.
    request.headers.delete("mcp-session-id");
    const response = await fetchOrFail(request);
    const headers = new Headers(response.headers);
    headers.delete("mcp-session-id");
    headers.set("x-content-type-options", "nosniff");
    return new Response(response.body, { status: response.status, headers });
  }

  const forward = toNodeListener(serve);

  function listener(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== "POST") {
      sendJsonRpcError(res, 405, "Method not allowed.", { allow: "POST" });
      return;
    }
    forward(req, res);
  }

  return {
    listener,
    close: async () => handler.close(),
  };
}

export { createMcpRoute };
export type { McpRoute };
