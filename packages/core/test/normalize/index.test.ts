import { gunzipSync } from "node:zlib";

import { normalizeItems } from "#src/normalize/index.js";
import type { NewItem } from "#src/normalize/types.js";

import { loadEnvelopeFixtures } from "../../../../test/fixtures/envelopes.js";

import { bytes, context, fixtureEnvelope, itemsOf, parse } from "./helpers.js";

const KNOWN_TYPES = new Set(["event", "transaction", "span", "log"]);

function kinds(newItems: NewItem[]): string[] {
  return newItems.map(({ item }) => `${item.kind}:${item.itemType}`);
}

describe("normalizeItems", () => {
  it("falls back to other for invalid JSON and keeps good items", () => {
    const envelope = parse(
      bytes(
        "{}\n",
        '{"type":"event"}\n{"message":"a"}\n',
        '{"type":"event"}\nnot json\n',
        '{"type":"log"}\n{"items":[{"body":"x"},{"body":"y"}]}\n',
      ),
    );
    const newItems = normalizeItems(envelope, context());
    expect(kinds(newItems)).toEqual(["message:event", "other:event", "log:log", "log:log"]);
    const [other] = itemsOf(newItems, "other");
    expect(other?.data.normalizeError).toMatch(/^invalid JSON/);
    const ids = newItems.map(({ item }) => item.id);
    expect(ids).toEqual(ids.toSorted());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("dispatches by item type", () => {
    const envelope = parse(
      bytes(
        '{"event_id":"5de6e5b4c2d54107b369e4ad5a6909cd"}\n',
        '{"type":"transaction"}\n{"transaction":"t"}\n',
        '{"type":"span"}\n{"items":[{"span_id":"a"}]}\n',
        '{"type":"attachment","length":3}\nabc\n',
        '{"type":"session"}\n{"sid":"x"}\n',
      ),
    );
    const newItems = normalizeItems(envelope, context({ envelopeHeader: envelope.header }));
    expect(kinds(newItems)).toEqual([
      "transaction:transaction",
      "span:span",
      "attachment:attachment",
      "other:session",
    ]);
  });

  it.each([
    ['{"type":"event"}\n"text"\n', "event payload is not a JSON object"],
    ['{"type":"span"}\n{"version":2}\n', "span payload has no items array"],
    ['{"type":"transaction"}\n[1]\n', "transaction payload is not a JSON object"],
  ])("turns { ok: false } into other for %j", (item, error) => {
    const [only] = normalizeItems(parse(bytes("{}\n", item)), context());
    expect(only?.item).toMatchObject({ kind: "other", data: { normalizeError: error } });
  });

  it("turns invalid UTF-8 into other", () => {
    const [only] = normalizeItems(
      parse(bytes("{}\n", '{"type":"event","length":2}\n', new Uint8Array([0xff, 0xfe]))),
      context(),
    );
    expect(only?.item).toMatchObject({
      kind: "other",
      itemType: "event",
      data: { payloadEncoding: "binary", normalizeError: "payload is not valid UTF-8" },
    });
    expect(only?.blob).toEqual(new Uint8Array([0xff, 0xfe]));
  });

  it.each(["event", "attachment"])("turns a truncated %s item into other", (type) => {
    const envelope = parse(bytes("{}\n", `{"type":"${type}","length":100}\n{"a":1}`));
    expect(envelope.items[0]?.truncated).toBe(true);
    const [only] = normalizeItems(envelope, context());
    expect(only?.item).toMatchObject({
      kind: "other",
      itemType: type,
      data: { normalizeError: "payload truncated" },
    });
  });

  it("turns a throwing normalizer into other", () => {
    let calls = 0;
    const newItems = normalizeItems(
      parse(bytes("{}\n", '{"type":"event"}\n{}\n')),
      context({
        newId: () => {
          calls += 1;
          if (calls === 1) {
            throw new Error("id boom");
          }
          return `id-${calls}`;
        },
      }),
    );
    expect(newItems).toHaveLength(1);
    expect(newItems[0]?.item).toMatchObject({
      kind: "other",
      id: "id-2",
      data: { normalizeError: "id boom" },
    });
  });

  it("normalizes the attachment fixture with event and attachment", () => {
    const envelope = fixtureEnvelope("node-attachment");
    expect(kinds(normalizeItems(envelope, context({ envelopeHeader: envelope.header })))).toEqual([
      "error:event",
      "attachment:attachment",
    ]);
  });

  describe("fixture sweep", () => {
    it.each(loadEnvelopeFixtures().map((fixture) => [fixture.meta.name, fixture] as const))(
      "%s normalizes without errors for known types",
      (_name, fixture) => {
        const body =
          fixture.meta.headers["content-encoding"] === "gzip"
            ? gunzipSync(fixture.body)
            : fixture.body;
        const envelope = parse(body);
        const newItems = normalizeItems(envelope, context({ envelopeHeader: envelope.header }));
        expect(newItems.length).toBeGreaterThanOrEqual(envelope.items.length);
        const failures = itemsOf(newItems, "other").filter(
          (other) => KNOWN_TYPES.has(other.itemType) || other.data.normalizeError !== null,
        );
        expect(failures.map((other) => `${other.itemType}: ${other.data.normalizeError}`)).toEqual(
          [],
        );
      },
    );
  });
});
