import { gunzipSync } from "node:zlib";

import type { NewItem, NormalizeContext } from "#src/normalize/types.js";
import { parseEnvelope } from "#src/parse/envelope.js";
import type { ParsedEnvelope, ParsedItem } from "#src/parse/envelope.js";
import type { Item } from "#src/types.js";

import { loadEnvelopeFixture } from "../../../../test/fixtures/envelopes.js";

const RECEIVED_AT = "2026-10-03T12:00:00.000Z";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function context(overrides: Partial<NormalizeContext> = {}): NormalizeContext {
  let next = 0;
  return {
    scope: { project: "p", session: "s", service: "svc" },
    envelopeId: "env-1",
    envelopeHeader: {},
    receivedAt: RECEIVED_AT,
    maxAttachmentBytes: 1024,
    allowedHosts: [],
    newId: () => `id-${String((next += 1)).padStart(4, "0")}`,
    ...overrides,
  };
}

function bytes(...parts: (string | Uint8Array)[]): Uint8Array {
  const chunks = parts.map((part) => (typeof part === "string" ? encoder.encode(part) : part));
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function parse(body: Uint8Array): ParsedEnvelope {
  const result = parseEnvelope(body);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.envelope;
}

function fixtureEnvelope(name: string): ParsedEnvelope {
  const fixture = loadEnvelopeFixture(name);
  const body =
    fixture.meta.headers["content-encoding"] === "gzip" ? gunzipSync(fixture.body) : fixture.body;
  return parse(body);
}

function fixtureItem(name: string, type: string): ParsedItem {
  const item = fixtureEnvelope(name).items.find((candidate) => candidate.header.type === type);
  if (item === undefined) {
    throw new Error(`${name}: no ${type} item`);
  }
  return item;
}

function fixturePayload(name: string, type: string): unknown {
  return JSON.parse(decoder.decode(fixtureItem(name, type).payload));
}

function rawItem(
  type: string,
  payload: string | Uint8Array,
  header: Record<string, unknown> = {},
): ParsedItem {
  return {
    header: { ...header, type },
    payload: typeof payload === "string" ? encoder.encode(payload) : payload,
    truncated: false,
  };
}

function records(result: { ok: true; items: NewItem[] } | { ok: false; error: string }): NewItem[] {
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.items;
}

function isKind<K extends Item["kind"]>(item: Item, kind: K): item is Extract<Item, { kind: K }> {
  return item.kind === kind;
}

function itemsOf<K extends Item["kind"]>(
  newItems: NewItem[],
  kind: K,
): Extract<Item, { kind: K }>[] {
  return newItems.flatMap(({ item }): Extract<Item, { kind: K }>[] =>
    isKind(item, kind) ? [item] : [],
  );
}

function only<T>(list: T[]): T {
  const [first] = list;
  if (first === undefined || list.length !== 1) {
    throw new Error(`expected exactly one entry, got ${list.length}`);
  }
  return first;
}

export {
  bytes,
  context,
  fixtureEnvelope,
  fixtureItem,
  fixturePayload,
  itemsOf,
  only,
  parse,
  rawItem,
  RECEIVED_AT,
  records,
};
