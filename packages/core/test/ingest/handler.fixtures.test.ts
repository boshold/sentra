import { createIngestHandler } from "#src/ingest/handler.js";
import type { IngestContext } from "#src/ingest/handler.js";
import { parseIngestPath } from "#src/ingest/route.js";

import {
  fixtureToRequest,
  loadEnvelopeFixture,
  loadEnvelopeFixtures,
} from "../../../../test/fixtures/envelopes.js";
import type { EnvelopeFixture } from "../../../../test/fixtures/envelopes.js";

async function ingest(
  fixture: EnvelopeFixture,
): Promise<{ response: Response; ctx: IngestContext }> {
  const calls: IngestContext[] = [];
  const handle = createIngestHandler({
    limits: { maxEnvelopeBytes: 20 * 1024 * 1024 },
    onEnvelope: async (ctx) => {
      calls.push(ctx);
      return { id: "test-id" };
    },
  });
  const response = await handle(fixtureToRequest(fixture));
  const [ctx] = calls;
  if (ctx === undefined) {
    throw new Error(`${fixture.meta.name}: sink not called (status ${response.status})`);
  }
  return { response, ctx };
}

function expectedScope(fixture: EnvelopeFixture): {
  project: string;
  session: string;
  service: string;
} {
  if (fixture.meta.scenario === "node-tunnel") {
    return { project: "my-app", session: "web", service: "default" };
  }
  const route = parseIngestPath(new URL(fixture.meta.path, "http://localhost").pathname);
  if (route === null) {
    throw new Error(`${fixture.meta.name}: not an ingest path`);
  }
  return route.scope;
}

describe("ingest handler with captured SDK fixtures", () => {
  it.each(loadEnvelopeFixtures().map((fixture) => [fixture.meta.name, fixture] as const))(
    "%s",
    async (_name, fixture) => {
      const { response, ctx } = await ingest(fixture);
      expect(response.status).toBe(200);
      expect(ctx.parseError).toBeNull();
      expect(ctx.parsed?.warnings).toEqual([]);
      expect(ctx.parsed?.items.map((item) => item.header.type)).toEqual(fixture.meta.itemTypes);
      expect(ctx.scope).toEqual(expectedScope(fixture));
    },
  );

  it("keeps the unscoped fixture at the default scope", async () => {
    const { ctx } = await ingest(loadEnvelopeFixture("node-unscoped"));
    expect(ctx.scope).toEqual({ project: "default", session: "default", service: "default" });
  });

  it("parses the empty attachment", async () => {
    const { ctx } = await ingest(loadEnvelopeFixture("node-empty-attachment"));
    const attachment = ctx.parsed?.items.find((item) => item.header.type === "attachment");
    expect(attachment?.payload.byteLength).toBe(0);
    expect(attachment?.truncated).toBe(false);
  });

  it("decompresses the gzip fixture", async () => {
    const { ctx } = await ingest(loadEnvelopeFixture("node-gzip"));
    expect(ctx.contentEncoding).toBe("gzip");
    expect(ctx.raw.length).toBeGreaterThan(32 * 1024);
  });
});
