// Records real @sentry/node and @sentry/browser requests as envelope fixtures.
// Usage: pnpm capture:fixtures (manual step, re-run when the SDK version is bumped).
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "test/fixtures/envelopes");
const SCRIPT = path.join(ROOT, "scripts/capture-fixtures.ts");
const CHILD_TIMEOUT_MS = 20_000;
const SERVER_NAME = "sentra-fixture";
const FLUSH_MS = 3000;

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

interface Recorder {
  port: number;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

interface Scenario {
  name: string;
  run: (port: number) => Promise<void>;
  statusFor?: (index: number) => number;
}

interface ScannedItem {
  type: string;
  payload: Buffer;
}

// --- recorder -------------------------------------------------------------

function lowerCaseHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      result[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  return result;
}

async function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

async function startRecorder(statusFor: (index: number) => number): Promise<Recorder> {
  const requests: RecordedRequest[] = [];
  let postIndex = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: lowerCaseHeaders(req.headers),
        body: Buffer.concat(chunks),
      });
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "access-control-allow-methods": "POST",
        });
        res.end();
        return;
      }
      res.writeHead(statusFor(postIndex), { "access-control-allow-origin": "*" });
      postIndex += 1;
      res.end("{}");
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("recorder has no TCP address"));
        return;
      }
      const { port }: AddressInfo = address;
      resolve({
        port,
        requests,
        close: async () => closeServer(server),
      });
    });
  });
}

// --- scenarios (run in a child process each: Sentry.init is process-global) ---

async function loadNodeSdk() {
  return import("@sentry/node");
}

type NodeSdk = Awaited<ReturnType<typeof loadNodeSdk>>;
type NodeOptions = Parameters<NodeSdk["init"]>[0];

async function withNode(
  options: NonNullable<NodeOptions>,
  body: (sentry: NodeSdk) => Promise<void> | void,
): Promise<void> {
  const Sentry = await loadNodeSdk();
  Sentry.init({ serverName: SERVER_NAME, ...options });
  await body(Sentry);
  await Sentry.flush(FLUSH_MS);
  await Sentry.close(FLUSH_MS);
}

async function loadBrowserSdk() {
  return import("@sentry/browser");
}

type BrowserSdk = Awaited<ReturnType<typeof loadBrowserSdk>>;

async function withBrowser(
  port: number,
  options: (
    sentry: BrowserSdk,
  ) => Omit<NonNullable<Parameters<BrowserSdk["init"]>[0]>, "dsn" | "transport">,
  body: (sentry: BrowserSdk) => Promise<void> | void,
): Promise<void> {
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  GlobalRegistrator.register({ url: "http://localhost:3000/app/page", width: 1024, height: 768 });
  try {
    const Sentry = await loadBrowserSdk();
    Sentry.init({
      dsn: `http://sentra@127.0.0.1:${port}/my-app/3f9a1c/web/1`,
      // Happy-dom: the default fetch lookup fails with "The window is closed".
      transport: (transportOptions) =>
        Sentry.makeFetchTransport(transportOptions, async (...args) => globalThis.fetch(...args)),
      ...options(Sentry),
    });
    await body(Sentry);
    await Sentry.flush(FLUSH_MS);
    await Sentry.close(FLUSH_MS);
  } finally {
    await GlobalRegistrator.unregister();
  }
}

function scopedDsn(port: number): string {
  return `http://sentra@127.0.0.1:${port}/my-app/3f9a1c/web/1`;
}

function boom(message: string): Error {
  try {
    throw new Error(message);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function libraryFrameError(): Error {
  const pkgRoot = path.join(ROOT, "node_modules/.cache/sentra-capture");
  const pkgDir = path.join(pkgRoot, "node_modules/fakepkg");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    path.join(pkgDir, "index.js"),
    'exports.thrower = function thrower() {\n  throw new Error("thrown inside fakepkg");\n};\n',
  );
  const require = createRequire(path.join(pkgRoot, "index.js"));
  try {
    const loaded: unknown = require("fakepkg");
    if (
      typeof loaded === "object" &&
      loaded !== null &&
      "thrower" in loaded &&
      typeof loaded.thrower === "function"
    ) {
      loaded.thrower();
    }
    return new Error("fakepkg did not throw");
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

const SCENARIOS: Scenario[] = [
  {
    name: "node-error",
    run: async (port) =>
      withNode({ dsn: scopedDsn(port) }, (Sentry) => {
        Sentry.captureException(boom("boom"));
      }),
  },
  {
    name: "node-message",
    run: async (port) =>
      withNode({ dsn: scopedDsn(port) }, (Sentry) => {
        Sentry.captureMessage("hello msg");
      }),
  },
  {
    name: "node-spans",
    run: async (port) =>
      withNode({ dsn: scopedDsn(port), tracesSampleRate: 1 }, (Sentry) => {
        Sentry.startSpan({ name: "my-span", op: "test" }, () => {
          Sentry.startSpan({ name: "child", op: "test.child" }, () => undefined);
        });
      }),
  },
  {
    name: "node-transaction",
    run: async (port) =>
      withNode(
        { dsn: scopedDsn(port), tracesSampleRate: 1, traceLifecycle: "static" },
        (Sentry) => {
          Sentry.startSpan({ name: "my-transaction", op: "test" }, () => {
            Sentry.startSpan({ name: "child", op: "test.child" }, () => undefined);
          });
        },
      ),
  },
  {
    name: "node-logs",
    run: async (port) =>
      withNode({ dsn: scopedDsn(port) }, (Sentry) => {
        Sentry.logger.info("info log", { foo: 1, bar: "b", baz: true, q: 1.5 });
        Sentry.logger.warn(Sentry.logger.fmt`templ ${42}`);
      }),
  },
  {
    name: "node-attachment",
    run: async (port) =>
      withNode({ dsn: scopedDsn(port) }, (Sentry) => {
        Sentry.getCurrentScope().addAttachment({
          filename: "a.txt",
          data: "line1\nline2\n",
          contentType: "text/plain",
        });
        Sentry.captureException(boom("boom with attachment"));
      }),
  },
  {
    name: "node-empty-attachment",
    run: async (port) =>
      withNode({ dsn: scopedDsn(port) }, (Sentry) => {
        Sentry.getCurrentScope().addAttachment({ filename: "empty.txt", data: "" });
        Sentry.captureException(boom("boom with empty attachment"));
      }),
  },
  {
    name: "node-gzip",
    run: async (port) =>
      withNode({ dsn: scopedDsn(port) }, (Sentry) => {
        Sentry.captureException(boom("big"), { extra: { blob: "x".repeat(40_000) } });
      }),
  },
  {
    name: "node-library-frame",
    run: async (port) =>
      withNode({ dsn: scopedDsn(port) }, (Sentry) => {
        Sentry.captureException(libraryFrameError());
      }),
  },
  {
    name: "node-tunnel",
    run: async (port) =>
      withNode(
        {
          dsn: "http://sentra@example.invalid:9000/my-app/web/1",
          tunnel: `http://127.0.0.1:${port}/api/1/envelope/`,
        },
        (Sentry) => {
          Sentry.captureException(boom("through tunnel"));
        },
      ),
  },
  {
    name: "node-session",
    run: async (port) =>
      withNode({ dsn: scopedDsn(port), release: "r1" }, (Sentry) => {
        Sentry.startSession();
        Sentry.endSession();
      }),
  },
  {
    name: "node-client-report",
    statusFor: (index) => (index === 0 ? 413 : 200),
    run: async (port) =>
      withNode({ dsn: scopedDsn(port) }, async (Sentry) => {
        Sentry.captureException(boom("rejected with 413"));
        await Sentry.flush(FLUSH_MS);
      }),
  },
  {
    name: "node-unscoped",
    run: async (port) =>
      withNode({ dsn: `http://sentra@127.0.0.1:${port}/1` }, (Sentry) => {
        Sentry.captureException(boom("unscoped"));
      }),
  },
  {
    name: "browser-error",
    run: async (port) =>
      withBrowser(
        port,
        () => ({}),
        (Sentry) => {
          Sentry.captureException(boom("browser boom"));
        },
      ),
  },
  {
    name: "browser-attachment",
    run: async (port) =>
      withBrowser(
        port,
        () => ({}),
        (Sentry) => {
          Sentry.getCurrentScope().addAttachment({
            filename: "b.bin",
            data: Uint8Array.of(1, 10, 2),
          });
          Sentry.captureMessage("bmsg");
        },
      ),
  },
  {
    name: "browser-logs-spans",
    run: async (port) =>
      withBrowser(
        port,
        (Sentry) => ({ tracesSampleRate: 1, integrations: [Sentry.browserTracingIntegration()] }),
        async (Sentry) => {
          Sentry.logger.info("browser log", { a: 1 });
          Sentry.startSpan({ name: "bspan", op: "test" }, () => undefined);
          await Sentry.flush(FLUSH_MS);
          document.dispatchEvent(new Event("visibilitychange"));
        },
      ),
  },
];

// --- envelope scanning and sanitizing ---------------------------------------

function isGzip(request: RecordedRequest): boolean {
  return request.headers["content-encoding"]?.trim().toLowerCase() === "gzip";
}

function parseHeaderLine(line: Buffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line.toString("utf8"));
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value));
    }
  } catch {
    // Not JSON.
  }
  return null;
}

function readLine(body: Buffer, start: number): { line: Buffer; next: number } {
  const newline = body.indexOf(0x0a, start);
  const end = newline === -1 ? body.byteLength : newline;
  return { line: body.subarray(start, end), next: newline === -1 ? end : end + 1 };
}

/** Minimal envelope scanner; the real parser lives in packages/core. */
function scanItems(body: Buffer): { header: Record<string, unknown> | null; items: ScannedItem[] } {
  const first = readLine(body, 0);
  const header = parseHeaderLine(first.line);
  const items: ScannedItem[] = [];
  let pos = first.next;
  while (pos < body.byteLength) {
    const { line, next } = readLine(body, pos);
    pos = next;
    if (line.byteLength === 0) {
      continue;
    }
    const itemHeader = parseHeaderLine(line);
    if (itemHeader === null || typeof itemHeader.type !== "string") {
      break;
    }
    const { length } = itemHeader;
    if (typeof length === "number" && Number.isInteger(length) && length >= 0) {
      const payload = body.subarray(pos, Math.min(pos + length, body.byteLength));
      pos = Math.min(pos + length, body.byteLength);
      if (body[pos] === 0x0a) {
        pos += 1;
      }
      items.push({ type: itemHeader.type, payload });
    } else {
      const payload = readLine(body, pos);
      pos = payload.next;
      items.push({ type: itemHeader.type, payload: payload.line });
    }
  }
  return { header, items };
}

function replaceAll(body: Buffer, search: string, replacement: string): Buffer {
  const needle = Buffer.from(search);
  const parts: Buffer[] = [];
  let start = 0;
  let index = body.indexOf(needle, start);
  while (index !== -1) {
    parts.push(body.subarray(start, index), Buffer.from(replacement));
    start = index + needle.byteLength;
    index = body.indexOf(needle, start);
  }
  if (parts.length === 0) {
    return body;
  }
  parts.push(body.subarray(start));
  return Buffer.concat(parts);
}

const REPLACEMENTS: [string, string][] = [
  [ROOT, "/workspace/app"],
  [os.homedir(), "/home/dev"],
  [os.hostname(), SERVER_NAME],
];

function sanitize(request: RecordedRequest): Buffer {
  const decoded = isGzip(request) ? gunzipSync(request.body) : request.body;
  const { items } = scanItems(decoded);
  const touchesAttachment = items.some(
    (item) =>
      item.type === "attachment" &&
      REPLACEMENTS.some(([search]) => item.payload.includes(Buffer.from(search))),
  );
  if (touchesAttachment) {
    return request.body;
  }
  let sanitized = decoded;
  for (const [search, replacement] of REPLACEMENTS) {
    sanitized = replaceAll(sanitized, search, replacement);
  }
  if (sanitized === decoded) {
    return request.body;
  }
  return isGzip(request) ? gzipSync(sanitized) : sanitized;
}

// --- parent ---------------------------------------------------------------

async function runChild(scenario: Scenario, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", SCRIPT, "--scenario", scenario.name],
      {
        cwd: ROOT,
        env: { ...process.env, SENTRA_CAPTURE_PORT: String(port) },
        stdio: "inherit",
      },
    );
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`scenario ${scenario.name} timed out after ${CHILD_TIMEOUT_MS} ms`));
    }, CHILD_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`scenario ${scenario.name} failed (code ${code}, signal ${signal})`));
      }
    });
  });
}

/** SDK from the envelope header; client reports carry none, so fall back to `sentry_client`. */
function sdkOf(
  header: Record<string, unknown> | null,
  url: string,
): { name: string; version: string } {
  const sdk = header?.sdk;
  if (typeof sdk === "object" && sdk !== null && "name" in sdk && "version" in sdk) {
    return { name: String(sdk.name), version: String(sdk.version) };
  }
  const client = new URL(url, "http://localhost").searchParams.get("sentry_client") ?? "";
  const separator = client.lastIndexOf("/");
  if (separator > 0) {
    return { name: client.slice(0, separator), version: client.slice(separator + 1) };
  }
  throw new Error(`cannot determine SDK for request ${url}`);
}

function writeFixtures(scenario: Scenario, requests: RecordedRequest[]): string[] {
  const posts = requests.filter((request) => request.method === "POST");
  if (posts.length === 0) {
    throw new Error(`scenario ${scenario.name} recorded no POST requests`);
  }
  return posts.map((request, index) => {
    const name = posts.length === 1 ? scenario.name : `${scenario.name}-${index + 1}`;
    const body = sanitize(request);
    const { header, items } = scanItems(isGzip(request) ? gunzipSync(body) : body);
    const headers: Record<string, string> = {};
    for (const key of ["content-type", "content-encoding"]) {
      const value = request.headers[key];
      if (value !== undefined) {
        headers[key] = value;
      }
    }
    const meta = {
      name,
      scenario: scenario.name,
      sdk: sdkOf(header, request.url),
      method: "POST",
      path: request.url,
      headers,
      bodyBytes: body.byteLength,
      itemTypes: items.map((item) => item.type),
    };
    writeFileSync(path.join(OUT_DIR, `${name}.bin`), body);
    writeFileSync(path.join(OUT_DIR, `${name}.json`), `${JSON.stringify(meta, null, 2)}\n`);
    return name;
  });
}

async function runParent(): Promise<void> {
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const names: string[] = [];
  try {
    for (const scenario of SCENARIOS) {
      const recorder = await startRecorder(scenario.statusFor ?? (() => 200));
      try {
        await runChild(scenario, recorder.port);
      } finally {
        await recorder.close();
      }
      const written = writeFixtures(scenario, recorder.requests);
      names.push(...written);
      console.log(`${scenario.name}: ${written.join(", ")}`);
    }
  } finally {
    rmSync(path.join(ROOT, "node_modules/.cache/sentra-capture"), { recursive: true, force: true });
  }
  names.sort();
  writeFileSync(path.join(OUT_DIR, "index.json"), `${JSON.stringify(names, null, 2)}\n`);
  console.log(`wrote ${names.length} fixtures to ${path.relative(ROOT, OUT_DIR)}`);
}

async function runScenario(name: string): Promise<void> {
  const scenario = SCENARIOS.find((candidate) => candidate.name === name);
  const port = Number(process.env.SENTRA_CAPTURE_PORT);
  if (scenario === undefined || !Number.isInteger(port) || port <= 0) {
    throw new Error(`unknown scenario ${name} or missing SENTRA_CAPTURE_PORT`);
  }
  await scenario.run(port);
}

const scenarioFlag = process.argv.indexOf("--scenario");
const scenarioName = scenarioFlag === -1 ? undefined : process.argv[scenarioFlag + 1];
await (scenarioName === undefined ? runParent() : runScenario(scenarioName));
