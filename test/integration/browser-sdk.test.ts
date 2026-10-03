import { fileURLToPath } from "node:url";

import type { Frame, Sentra } from "@bosdev/sentra-core";

import { findOne, getFull, listAll, narrow, posts, runOk } from "./helpers/records.js";
import { startSentraServer } from "./helpers/server.js";
import type { SentraServer } from "./helpers/server.js";

const SCOPE = { project: "my-app", session: "3f9a1c", service: "web" };
const DEP_PATH = "/node_modules/.vite/deps/";
const CARD_URL = "http://localhost:3000/src/components/Card.vue";

let server: SentraServer;
let sentra: Sentra;

function locationOf(frame: Frame): string {
  return frame.absPath ?? frame.filename ?? "";
}

beforeAll(async () => {
  // Frames point at http://localhost:3000, which Sentra must not try to fetch.
  server = await startSentraServer({ sourceMaps: { enabled: false } });
  ({ sentra } = server);
  await runOk(fileURLToPath(new URL("scenarios/browser-basic.mjs", import.meta.url)), {
    SENTRA_DSN: sentra.getDsn(SCOPE),
  });
});

afterAll(async () => {
  await server.close();
});

describe("browser sdk", () => {
  it("preflight", async () => {
    const preflights = server.requests.filter((request) => request.method === "OPTIONS");
    expect(preflights.some((request) => request.status === 204)).toBe(true);

    const response = await fetch(`${server.baseUrl}/my-app/3f9a1c/web/api/1/envelope/`, {
      method: "OPTIONS",
    });
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    expect(response.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
      "content-type",
    );
  });

  it("all POSTs accepted", () => {
    const sent = posts(server.requests);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((request) => request.status === 200)).toBe(true);
  });

  it("error envelope (text/plain)", async () => {
    const sent = posts(server.requests);
    const typed = sent.filter((request) => request.contentType !== null);
    expect(sent.length - typed.length).toBe(1);
    expect(typed.every((request) => request.contentType?.startsWith("text/plain") === true)).toBe(
      true,
    );

    const error = await findOne(sentra, "error", "Error: browser boom");
    expect(error.platform).toBe("javascript");
    expect(error.scope).toEqual(SCOPE);
    expect(error.release).toBe("r1");
    expect(error.data.request?.url).toBe("http://localhost:3000/app/page");
  });

  it("attachment envelope (no content type)", async () => {
    const untyped = posts(server.requests).filter((request) => request.contentType === null);
    expect(untyped).toHaveLength(1);
    expect(untyped[0]?.status).toBe(200);

    const message = await findOne(sentra, "message", "bmsg");
    const summaries = await listAll(sentra, { kind: "attachment" });
    expect(summaries).toHaveLength(1);
    const attachment = narrow(await getFull(sentra, summaries[0]), "attachment");
    expect(attachment.data.filename).toBe("b.bin");
    expect(attachment.data.size).toBe(3);
    expect(attachment.eventId).not.toBeNull();
    expect(attachment.eventId).toBe(message.eventId);
    const blob = await sentra.query.getBlob(attachment.id);
    expect(blob === null ? null : [...blob.data]).toEqual([1, 10, 2]);
  });

  it("captureMessage → message", async () => {
    const message = await findOne(sentra, "message", "bmsg");
    expect(message.level).toBe("info");
    expect(message.data.exceptions).toEqual([]);
    const errors = await listAll(sentra, { kind: "error" });
    expect(errors.some((item) => item.title === "bmsg")).toBe(false);
  });

  it("inApp recomputed", async () => {
    const error = await findOne(sentra, "error", "Error: dep boom");
    const frames = error.data.exceptions.flatMap((exception) => exception.frames);
    const dependency = frames.filter((frame) => locationOf(frame).includes(DEP_PATH));
    expect(dependency).toHaveLength(1);
    expect(dependency[0]?.inApp).toBe(false);
    const card = frames.filter((frame) => locationOf(frame) === CARD_URL);
    expect(card).toHaveLength(1);
    expect(card[0]?.inApp).toBe(true);
  });

  it("grouping ignores library frames", async () => {
    const error = await findOne(sentra, "error", "Error: dep boom");
    expect(error.issueId).not.toBeNull();
    const issue = await sentra.query.getIssue(error.issueId ?? "");
    expect(issue).not.toBeNull();
    const fingerprint = issue?.fingerprint ?? [];
    expect(fingerprint.some((component) => component.includes("Card.vue"))).toBe(true);
    expect(fingerprint.some((component) => component.includes(".vite/deps"))).toBe(false);
  });

  it("log and span", async () => {
    const logs = await listAll(sentra, { kind: "log" });
    const items = await Promise.all(
      logs.map(async (summary) => narrow(await getFull(sentra, summary), "log")),
    );
    const log = items.find((item) => item.data.body === "browser log");
    expect(log?.data.attributes.a).toBe(1);

    const spans = await listAll(sentra, { kind: "span" });
    const full = await Promise.all(
      spans.map(async (summary) => narrow(await getFull(sentra, summary), "span")),
    );
    expect(full.some((span) => span.data.name === "bspan")).toBe(true);
  });

  it("session with release", async () => {
    const sessions = await listAll(sentra, { itemType: "session" });
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((item) => item.kind === "other")).toBe(true);
  });
});
