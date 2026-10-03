import os from "node:os";
import { gunzipSync } from "node:zlib";

import { array, boolean, looseObject, string } from "zod";
import type { infer as Infer } from "zod";

import { parseEnvelope } from "#src/parse/envelope.js";
import type { ParsedEnvelope, ParsedItem } from "#src/parse/envelope.js";

import { fixtureToRequest, loadEnvelopeFixtures } from "../../../../test/fixtures/envelopes.js";
import type { EnvelopeFixture } from "../../../../test/fixtures/envelopes.js";

const fixtures = loadEnvelopeFixtures();
const decoder = new TextDecoder();

function decoded(fixture: EnvelopeFixture): Uint8Array {
  return fixture.meta.headers["content-encoding"] === "gzip"
    ? gunzipSync(fixture.body)
    : fixture.body;
}

function parsed(fixture: EnvelopeFixture): ParsedEnvelope {
  const result = parseEnvelope(decoded(fixture));
  if (!result.ok) {
    throw new Error(`${fixture.meta.name}: ${result.error}`);
  }
  return result.envelope;
}

function items(fixture: EnvelopeFixture, type: string): ParsedItem[] {
  return parsed(fixture).items.filter((item) => item.header.type === type);
}

function json(item: ParsedItem): unknown {
  return JSON.parse(decoder.decode(item.payload));
}

function pathnameOf(fixture: EnvelopeFixture): string {
  return new URL(fixture.meta.path, "http://localhost").pathname;
}

const exceptionPayloadSchema = looseObject({
  exception: looseObject({
    values: array(
      looseObject({
        type: string().optional(),
        stacktrace: looseObject({
          frames: array(looseObject({ in_app: boolean().optional() })).optional(),
        }).optional(),
      }),
    ),
  }),
});

type ExceptionValue = Infer<typeof exceptionPayloadSchema>["exception"]["values"][number];

function exceptionValues(item: ParsedItem): ExceptionValue[] {
  const result = exceptionPayloadSchema.safeParse(json(item));
  return result.success ? result.data.exception.values : [];
}

function hasField(item: ParsedItem, field: string): boolean {
  const payload = json(item);
  return typeof payload === "object" && payload !== null && field in payload;
}

const scenarios: { scenario: string; holds: (fixture: EnvelopeFixture) => boolean }[] = [
  {
    scenario: "node-error",
    holds: (f) => items(f, "event").some((item) => exceptionValues(item)[0]?.type === "Error"),
  },
  {
    scenario: "node-message",
    holds: (f) =>
      items(f, "event").some(
        (item) =>
          hasField(item, "message") &&
          exceptionValues(item).length > 0 &&
          exceptionValues(item).every((value) => value.type === undefined),
      ),
  },
  {
    scenario: "node-spans",
    holds: (f) =>
      items(f, "span").some(
        (item) => item.header.content_type === "application/vnd.sentry.items.span.v2+json",
      ),
  },
  { scenario: "node-transaction", holds: (f) => items(f, "transaction").length > 0 },
  {
    scenario: "node-logs",
    holds: (f) =>
      items(f, "log").some(
        (item) => typeof item.header.item_count === "number" && item.header.item_count >= 2,
      ),
  },
  {
    scenario: "node-attachment",
    holds: (f) =>
      items(f, "event").length > 0 &&
      items(f, "attachment").some((item) => item.header.length === 12),
  },
  {
    scenario: "node-empty-attachment",
    holds: (f) => items(f, "attachment").some((item) => item.header.length === 0),
  },
  {
    scenario: "node-gzip",
    holds: (f) =>
      f.meta.headers["content-encoding"] === "gzip" && f.body[0] === 0x1f && f.body[1] === 0x8b,
  },
  {
    scenario: "node-library-frame",
    holds: (f) =>
      items(f, "event").some((item) =>
        exceptionValues(item).some((value) =>
          (value.stacktrace?.frames ?? []).some((frame) => frame.in_app === false),
        ),
      ),
  },
  {
    scenario: "node-tunnel",
    holds: (f) => typeof parsed(f).header.dsn === "string" && pathnameOf(f) === "/api/1/envelope/",
  },
  { scenario: "node-session", holds: (f) => items(f, "session").length > 0 },
  { scenario: "node-client-report", holds: (f) => items(f, "client_report").length > 0 },
  { scenario: "node-unscoped", holds: (f) => pathnameOf(f) === "/api/1/envelope/" },
  {
    scenario: "browser-error",
    holds: (f) => f.meta.headers["content-type"] === "text/plain;charset=UTF-8",
  },
  {
    scenario: "browser-attachment",
    holds: (f) =>
      f.meta.headers["content-type"] === undefined &&
      items(f, "attachment").some((item) => item.header.length === 3),
  },
  { scenario: "browser-logs-spans", holds: (f) => items(f, "log").length > 0 },
  { scenario: "browser-logs-spans", holds: (f) => items(f, "span").length > 0 },
];

describe("envelope fixtures", () => {
  it("has one entry per index name with matching meta", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(16);
    for (const fixture of fixtures) {
      expect(fixture.meta.name.startsWith(fixture.meta.scenario)).toBe(true);
      expect(fixture.body.byteLength).toBe(fixture.meta.bodyBytes);
      expect(parsed(fixture).items.map((item) => item.header.type)).toEqual(fixture.meta.itemTypes);
    }
  });

  it.each(scenarios)("$scenario has a matching fixture", ({ scenario, holds }) => {
    const ofScenario = fixtures.filter((fixture) => fixture.meta.scenario === scenario);
    expect(ofScenario.length).toBeGreaterThan(0);
    expect(ofScenario.some((fixture) => holds(fixture))).toBe(true);
  });

  it("contains no local home directory or host name", () => {
    const home = os.homedir();
    const host = os.hostname();
    for (const fixture of fixtures) {
      const content = decoder.decode(decoded(fixture));
      expect(content.includes(home), `${fixture.meta.name} contains ${home}`).toBe(false);
      expect(content.includes(host), `${fixture.meta.name} contains ${host}`).toBe(false);
    }
  });

  it("rebuilds the recorded request", async () => {
    const fixture = fixtures.find((candidate) => candidate.meta.scenario === "node-gzip");
    if (fixture === undefined) {
      throw new Error("missing node-gzip fixture");
    }
    const request = fixtureToRequest(fixture);
    expect(request.method).toBe("POST");
    expect(request.url).toBe(`http://localhost:8969${fixture.meta.path}`);
    expect(request.headers.get("content-encoding")).toBe("gzip");
    expect(new Uint8Array(await request.arrayBuffer())).toEqual(fixture.body);
  });
});
