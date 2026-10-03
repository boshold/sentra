import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Frame, Item, Sentra } from "@bosdev/sentra-core";

import { findOne, getFull, isKind, listAll, narrow, posts, runOk } from "./helpers/records.js";
import { startSentraServer } from "./helpers/server.js";
import type { SentraServer } from "./helpers/server.js";

const SCOPE = { project: "my-app", session: "3f9a1c", service: "web" };
const BASIC_FILE = "node-basic.mjs";
const GZIP_FILE = "node-modules-gzip.mjs";

let fakepkgDir = "";
let fakepkgPath = "";

function scenarioPath(name: string): string {
  return fileURLToPath(new URL(`scenarios/${name}`, import.meta.url));
}

function exceptionFrames(item: Item): Frame[] {
  if (!isKind(item, "error")) {
    throw new Error(`expected an error record, got ${item.kind}`);
  }
  return item.data.exceptions.flatMap((exception) => exception.frames);
}

function framesOf(frames: Frame[], fileName: string): Frame[] {
  return frames.filter((frame) => frame.filename?.endsWith(`/${fileName}`) === true);
}

beforeAll(async () => {
  fakepkgDir = await mkdtemp(path.join(tmpdir(), "sentra-"));
  const pkgDir = path.join(fakepkgDir, "node_modules", "fakepkg");
  await mkdir(pkgDir, { recursive: true });
  fakepkgPath = path.join(pkgDir, "index.cjs");
  await writeFile(
    fakepkgPath,
    'exports.thrower = () => {\n  throw new Error("from dep");\n};\n',
    "utf8",
  );
});

afterAll(async () => {
  await rm(fakepkgDir, { recursive: true, force: true });
});

describe("node-basic scenario", () => {
  let server: SentraServer;
  let sentra: Sentra;

  beforeAll(async () => {
    server = await startSentraServer();
    ({ sentra } = server);
    await runOk(scenarioPath(BASIC_FILE), { SENTRA_DSN: sentra.getDsn(SCOPE) });
  });

  afterAll(async () => {
    await server.close();
  });

  it("captureException → error record and issue", async () => {
    const latest = await findOne(sentra, "error", "Error: boom 2");
    expect(latest.scope).toEqual(SCOPE);
    expect(latest.platform).toBe("node");
    expect(latest.release).toBe("r1");
    const frames = exceptionFrames(latest);
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame.absPath).toBeNull();
      // Node builtins such as `node:internal/modules/run_main` have no file path.
      if (frame.filename?.startsWith("node:") !== true) {
        expect(path.isAbsolute(frame.filename ?? "")).toBe(true);
      }
    }
    const own = framesOf(frames, BASIC_FILE);
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((frame) => frame.inApp)).toBe(true);
    expect(latest.issueId).not.toBeNull();
  });

  it("same error twice → one issue, count 2", async () => {
    const issues = await sentra.query.listIssues({
      project: SCOPE.project,
      session: SCOPE.session,
      kind: "error",
    });
    expect(issues.items).toHaveLength(1);
    const [issue] = issues.items;
    expect(issue?.title).toContain("boom");
    expect(issue?.count).toBe(2);
    expect(issue?.services).toEqual(["web"]);
    const first = await findOne(sentra, "error", "Error: boom 1");
    const second = await findOne(sentra, "error", "Error: boom 2");
    expect(first.issueId).toBe(issue?.id);
    expect(second.issueId).toBe(issue?.id);
  });

  it("captureMessage → message, not error", async () => {
    const message = await findOne(sentra, "message", "hello msg");
    expect(message.level).toBe("info");
    expect(message.data.exceptions).toEqual([]);
    expect(message.data.stacktrace.length).toBeGreaterThan(0);
    expect(message.issueId).not.toBeNull();
    expect(await listAll(sentra, { kind: "error", q: "hello msg" })).toEqual([]);
  });

  it("streamed spans", async () => {
    const summaries = await listAll(sentra, { kind: "span" });
    expect(summaries).toHaveLength(2);
    const spans = await Promise.all(
      summaries.map(async (summary) => narrow(await getFull(sentra, summary), "span")),
    );
    const segment = spans.find((span) => span.data.name === "my-span");
    const child = spans.find((span) => span.data.name === "child");
    expect(segment?.data.isSegment).toBe(true);
    expect(segment?.data.op).toBe("test");
    expect(child?.data.isSegment).toBe(false);
    expect(child?.data.parentSpanId).toBe(segment?.data.spanId);
    expect(segment?.traceId).not.toBeNull();
    expect(child?.traceId).toBe(segment?.traceId);
    expect(await listAll(sentra, { kind: "transaction" })).toEqual([]);
  });

  it("logs", async () => {
    const [segment] = await listAll(sentra, { kind: "span", q: "my-span" });
    const inSpan = await findOne(sentra, "log", "log in span x");
    expect(inSpan.data.attributes).toMatchObject({ "sentry.message.template": "log in span %s" });
    expect(inSpan.traceId).not.toBeNull();
    expect(inSpan.traceId).toBe(segment?.traceId);

    const info = await findOne(sentra, "log", "info log");
    expect(info.level).toBe("info");
    expect(info.release).toBe("r1");
    expect(info.data.attributes).toMatchObject({
      foo: 1,
      bar: "b",
      baz: true,
      q: 1.5,
      "sentry.release": "r1",
    });

    const warn = await findOne(sentra, "log", "warn log");
    expect(warn.level).toBe("warning");
  });

  it("attachment via scope", async () => {
    const summaries = await listAll(sentra, { kind: "attachment" });
    expect(summaries).toHaveLength(1);
    const attachment = narrow(await getFull(sentra, summaries[0]), "attachment");
    expect(attachment.data).toMatchObject({
      filename: "a.txt",
      contentType: "text/plain",
      size: 12,
      stored: true,
    });
    const first = await findOne(sentra, "error", "Error: boom 1");
    expect(attachment.eventId).not.toBeNull();
    expect(attachment.eventId).toBe(first.eventId);
    const blob = await sentra.query.getBlob(attachment.id);
    expect(blob === null ? null : new TextDecoder().decode(blob.data)).toBe("line1\nline2\n");
  });

  it("session only with release", async () => {
    const sessions = await listAll(sentra, { itemType: "session" });
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((item) => item.kind === "other")).toBe(true);
  });

  it("no content type", () => {
    const sent = posts(server.requests);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((request) => request.contentType === null)).toBe(true);
    expect(sent.every((request) => request.status === 200)).toBe(true);
  });
});

describe("node-static scenario", () => {
  let server: SentraServer;
  let sentra: Sentra;

  beforeAll(async () => {
    server = await startSentraServer();
    ({ sentra } = server);
    await runOk(scenarioPath("node-static.mjs"), { SENTRA_DSN: sentra.getDsn(SCOPE) });
  });

  afterAll(async () => {
    await server.close();
  });

  it("static lifecycle → transaction", async () => {
    const summaries = await listAll(sentra, { kind: "transaction" });
    expect(summaries).toHaveLength(1);
    const transaction = narrow(await getFull(sentra, summaries[0]), "transaction");
    expect(transaction.scope).toEqual(SCOPE);
    expect(transaction.data.name).toBe("my-span");
    expect(transaction.data.spans).toHaveLength(1);
    expect(transaction.data.durationMs).toBeGreaterThanOrEqual(0);
    expect(await listAll(sentra, { ...SCOPE, kind: "span" })).toEqual([]);
  });

  it("no session without release", async () => {
    expect(await listAll(sentra, { itemType: "session" })).toEqual([]);
  });
});

describe("node-modules-gzip scenario", () => {
  let server: SentraServer;
  let sentra: Sentra;

  beforeAll(async () => {
    server = await startSentraServer();
    ({ sentra } = server);
    await runOk(scenarioPath(GZIP_FILE), {
      SENTRA_DSN: sentra.getDsn(SCOPE),
      FAKEPKG_PATH: fakepkgPath,
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it("node_modules frame", async () => {
    const error = await findOne(sentra, "error", "Error: from dep");
    const frames = exceptionFrames(error);
    const dependency = frames.filter(
      (frame) => frame.filename?.includes("/node_modules/fakepkg/") === true,
    );
    expect(dependency.length).toBeGreaterThan(0);
    expect(dependency.every((frame) => !frame.inApp)).toBe(true);
    const own = framesOf(frames, GZIP_FILE);
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((frame) => frame.inApp)).toBe(true);
  });

  it("gzip above 32 KiB", async () => {
    const sent = posts(server.requests);
    const gzipped = sent.filter((request) => request.contentEncoding === "gzip");
    expect(gzipped).toHaveLength(1);
    expect(gzipped[0]?.status).toBe(200);
    expect(
      sent
        .filter((request) => request.contentEncoding !== "gzip")
        .every((request) => request.contentEncoding === null),
    ).toBe(true);
    const big = await findOne(sentra, "error", "Error: big");
    const { blob } = big.data.extra;
    expect(typeof blob === "string" ? blob.length : null).toBe(40_000);
  });

  it("no content type", () => {
    const sent = posts(server.requests);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((request) => request.contentType === null)).toBe(true);
    expect(sent.every((request) => request.status === 200)).toBe(true);
  });
});

describe("node-tunnel scenario", () => {
  let server: SentraServer;
  let sentra: Sentra;

  beforeAll(async () => {
    server = await startSentraServer();
    ({ sentra } = server);
  });

  beforeEach(async () => {
    await sentra.clear();
  });

  afterAll(async () => {
    await server.close();
  });

  it("short DSN → default scope", async () => {
    await runOk(scenarioPath("node-tunnel.mjs"), {
      SENTRA_DSN: `http://sentra@127.0.0.1:${server.port}/1`,
    });
    const error = await findOne(sentra, "error", "Error: tunneled");
    expect(error.scope).toEqual({ project: "default", session: "default", service: "default" });
  });

  it("tunnel → scope from envelope header DSN", async () => {
    await runOk(scenarioPath("node-tunnel.mjs"), {
      SENTRA_DSN: "http://sentra@example.invalid:9000/my-app/3f9a1c/api/1",
      SENTRA_TUNNEL: `${server.baseUrl}/api/1/envelope/`,
    });
    const error = await findOne(sentra, "error", "Error: tunneled");
    expect(error.scope).toEqual({ project: "my-app", session: "3f9a1c", service: "api" });
  });
});
