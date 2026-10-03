import { readFileSync } from "node:fs";
import path from "node:path";

import { array, literal, number, object, string } from "zod";
import type { infer as Infer } from "zod";

const ENVELOPES_DIR = path.join(import.meta.dirname, "envelopes");
const DEFAULT_BASE_URL = "http://localhost:8969";

const metaSchema = object({
  name: string(),
  scenario: string(),
  sdk: object({ name: string(), version: string() }),
  method: literal("POST"),
  path: string(),
  headers: object({
    "content-type": string().optional(),
    "content-encoding": string().optional(),
  }),
  bodyBytes: number().int().nonnegative(),
  itemTypes: array(string()),
});

const indexSchema = array(string());

type EnvelopeFixtureMeta = Infer<typeof metaSchema>;

interface EnvelopeFixture {
  meta: EnvelopeFixtureMeta;
  body: Uint8Array<ArrayBuffer>;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(path.join(ENVELOPES_DIR, file), "utf8"));
}

function loadEnvelopeFixture(name: string): EnvelopeFixture {
  const meta = metaSchema.parse(readJson(`${name}.json`));
  const body = new Uint8Array(readFileSync(path.join(ENVELOPES_DIR, `${name}.bin`)));
  return { meta, body };
}

function loadEnvelopeFixtures(): EnvelopeFixture[] {
  return indexSchema.parse(readJson("index.json")).map((name) => loadEnvelopeFixture(name));
}

/** Rebuilds the recorded request against `baseUrl`. */
function fixtureToRequest(fixture: EnvelopeFixture, baseUrl: string = DEFAULT_BASE_URL): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(fixture.meta.headers)) {
    if (value !== undefined) {
      headers.set(key, value);
    }
  }
  return new Request(new URL(fixture.meta.path, baseUrl), {
    method: fixture.meta.method,
    headers,
    body: fixture.body,
  });
}

export { fixtureToRequest, loadEnvelopeFixture, loadEnvelopeFixtures };
export type { EnvelopeFixture, EnvelopeFixtureMeta };
