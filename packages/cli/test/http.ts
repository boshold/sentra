import { request } from "node:http";
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** Raw `node:http` request, so `Host` can be overridden. */
async function httpRequest(
  port: number,
  options: {
    method?: string;
    path: string;
    headers?: OutgoingHttpHeaders;
    body?: Uint8Array | string;
  },
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path: options.path,
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

export { httpRequest, parseJson };
export type { HttpResult };
