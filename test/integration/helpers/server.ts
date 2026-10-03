import { createServer } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";

import { createSentra, memoryStorage, toNodeListener } from "@bosdev/sentra-core";
import type { Sentra, SentraOptions } from "@bosdev/sentra-core";

interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  /** Header value or `null`. */
  contentType: string | null;
  /** Header value or `null`. */
  contentEncoding: string | null;
  /** `0` until the response finished. */
  status: number;
}

interface SentraServer {
  sentra: Sentra;
  port: number;
  /** `http://127.0.0.1:<port>`. */
  baseUrl: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

/** Real `node:http` server on `127.0.0.1:0` serving `sentra.handle`; records every request. */
async function startSentraServer(options: SentraOptions = {}): Promise<SentraServer> {
  const requests: RecordedRequest[] = [];
  let listener: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;
  const server = createServer((req, res) => {
    const recorded: RecordedRequest = {
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
      contentType: req.headers["content-type"] ?? null,
      contentEncoding: req.headers["content-encoding"] ?? null,
      status: 0,
    };
    requests.push(recorded);
    res.on("finish", () => {
      recorded.status = res.statusCode;
    });
    if (listener === null) {
      res.writeHead(503).end();
      return;
    }
    listener(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("server has no TCP address");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let sentra: Sentra;
  try {
    sentra = await createSentra({ storage: memoryStorage(), publicUrl: baseUrl, ...options });
  } catch (error) {
    server.close();
    throw error;
  }
  listener = toNodeListener(sentra.handle);
  return {
    sentra,
    port: address.port,
    baseUrl,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
        server.closeAllConnections();
      });
      await sentra.close();
    },
  };
}

export { startSentraServer };
export type { RecordedRequest, SentraServer };
