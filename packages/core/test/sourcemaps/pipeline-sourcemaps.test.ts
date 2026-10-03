import { mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { SentraConfigError } from "#src/errors.js";
import { createSentra } from "#src/sentra.js";
import type { Sentra } from "#src/sentra.js";
import { memoryStorage } from "#src/storage/memory/index.js";
import type { EventData, Frame } from "#src/types.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

let base = "";
let root = "";
let bundle = "";
const instances: Sentra[] = [];

interface RawFrame {
  filename: string;
  lineno: number;
  colno: number;
  function: string;
}

function eventId(n: number): string {
  return n.toString(16).padStart(32, "0");
}

function envelope(id: string, payload: Record<string, unknown>): Request {
  const body = [
    JSON.stringify({ event_id: id }),
    JSON.stringify({ type: "event" }),
    JSON.stringify({ event_id: id, platform: "node", ...payload }),
  ].join("\n");
  return new Request("http://localhost:8969/p/s/web/api/1/envelope/", { method: "POST", body });
}

function errorEnvelope(id: string, frames: RawFrame[]): Request {
  return envelope(id, {
    exception: {
      values: [
        {
          type: "Error",
          value: "boom",
          stacktrace: { frames: frames.map((f) => ({ ...f, in_app: true })) },
        },
      ],
    },
  });
}

async function sentra(
  sourceMaps: Record<string, unknown> = { sourceRoots: [root] },
): Promise<Sentra> {
  const instance = await createSentra({ storage: memoryStorage(), sourceMaps });
  instances.push(instance);
  return instance;
}

async function eventData(instance: Sentra, id: string): Promise<EventData | null> {
  const item = await instance.query.getItemByEventId(id);
  return item?.kind === "error" || item?.kind === "message" ? item.data : null;
}

function firstFrame(data: EventData | null): Frame | undefined {
  return data?.exceptions.at(-1)?.frames.at(-1);
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), "sentra-pipeline-sm-")));
  root = path.join(base, "app");
  await mkdir(path.join(root, ".output/server"), { recursive: true });
  await mkdir(path.join(root, "server/api"), { recursive: true });
  bundle = path.join(root, ".output/server/index.mjs");
  await writeFile(bundle, "a();\nb();\n//# sourceMappingURL=index.mjs.map\n");
  // Generated lines 1 and 2 both map to server/api/boom.ts line 2.
  await writeFile(
    `${bundle}.map`,
    JSON.stringify({
      version: 3,
      sources: ["../../server/api/boom.ts"],
      names: [],
      mappings: "AACA;AAAA",
    }),
  );
  await writeFile(
    path.join(root, "server/api/boom.ts"),
    "export default () => {\n  throw new Error('boom')\n}\n",
  );
});

afterAll(async () => {
  await Promise.all(instances.map(async (instance) => instance.close()));
  await rm(base, { recursive: true, force: true });
});

beforeEach(() => {
  vi.mocked(open).mockClear();
});

describe("source maps in the ingest pipeline", () => {
  it("maps frames before storing", async () => {
    const instance = await sentra();
    const response = await instance.handle(
      errorEnvelope(eventId(1), [
        { filename: pathToFileURL(bundle).href, lineno: 1, colno: 1, function: "handler" },
      ]),
    );
    expect(response.status).toBe(200);
    const data = await eventData(instance, eventId(1));
    expect(firstFrame(data)?.mapped).toMatchObject({
      source: "server/api/boom.ts",
      lineno: 2,
      contextLine: "  throw new Error('boom')",
    });
    expect(data?.sourceMaps.status).toBe("full");
  });

  it("groups by the mapped location", async () => {
    const instance = await sentra();
    for (const [n, lineno] of [
      [2, 1],
      [3, 2],
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- sequential ingest
      await instance.handle(
        errorEnvelope(eventId(n ?? 0), [
          { filename: bundle, lineno: lineno ?? 1, colno: 1, function: "handler" },
        ]),
      );
    }
    const issues = await instance.query.listIssues();
    expect(issues.items).toHaveLength(1);
    const [issue] = issues.items;
    expect(issue?.count).toBe(2);
    expect(issue?.fingerprint.join("\n")).toContain("server/api/boom.ts");
    expect(issue?.fingerprint.join("\n")).not.toContain("index.mjs");
  });

  it("does nothing when disabled", async () => {
    const instance = await sentra({ enabled: false, sourceRoots: [root] });
    await instance.handle(
      errorEnvelope(eventId(4), [{ filename: bundle, lineno: 1, colno: 1, function: "handler" }]),
    );
    const data = await eventData(instance, eventId(4));
    expect(firstFrame(data)?.mapped).toBeNull();
    expect(data?.sourceMaps.status).toBe("not_applicable");
    expect(vi.mocked(open)).not.toHaveBeenCalled();
    instance.addSourceRoot(root);
    instance.removeSourceRoot(root);
  });

  it("stores the record when the dev server is unreachable", async () => {
    const instance = await sentra();
    const url = "http://127.0.0.1:1/src/main.ts";
    const response = await instance.handle(
      errorEnvelope(eventId(5), [{ filename: url, lineno: 1, colno: 1, function: "main" }]),
    );
    expect(response.status).toBe(200);
    const data = await eventData(instance, eventId(5));
    expect(data?.sourceMaps).toMatchObject({
      status: "none",
      errors: [{ absPath: url, reason: "fetch_failed" }],
    });
  });

  it("rejects relative source roots", async () => {
    await expect(
      createSentra({ storage: memoryStorage(), sourceMaps: { sourceRoots: ["relative/dir"] } }),
    ).rejects.toMatchObject({ code: "invalid_option" });
    await expect(
      createSentra({ storage: memoryStorage(), sourceMaps: { sourceRoots: ["relative/dir"] } }),
    ).rejects.toBeInstanceOf(SentraConfigError);
  });

  it("maps the stacktrace of message records", async () => {
    const instance = await sentra();
    await instance.handle(
      envelope(eventId(6), {
        message: "hello",
        level: "info",
        stacktrace: {
          frames: [{ filename: bundle, lineno: 2, colno: 1, function: "log", in_app: true }],
        },
      }),
    );
    const data = await eventData(instance, eventId(6));
    expect(data?.stacktrace.at(-1)?.mapped).toMatchObject({
      source: "server/api/boom.ts",
      lineno: 2,
    });
    expect(data?.sourceMaps.status).toBe("full");
  });

  it("uses source roots added at runtime", async () => {
    const instance = await sentra({});
    instance.addSourceRoot(root);
    instance.addSourceRoot(root);
    await instance.handle(
      errorEnvelope(eventId(7), [{ filename: bundle, lineno: 1, colno: 1, function: "handler" }]),
    );
    const mapped = await eventData(instance, eventId(7));
    expect(mapped?.sourceMaps.status).toBe("full");
    instance.removeSourceRoot(root);
    await instance.handle(
      errorEnvelope(eventId(8), [{ filename: bundle, lineno: 1, colno: 1, function: "handler" }]),
    );
    const unmapped = await eventData(instance, eventId(8));
    expect(unmapped?.sourceMaps.status).toBe("not_applicable");
    expect(() => instance.addSourceRoot("relative")).toThrow(SentraConfigError);
  });
});
