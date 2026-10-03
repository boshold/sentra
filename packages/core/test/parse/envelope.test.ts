import { serializeEnvelope } from "@sentry/core";
import type { Envelope } from "@sentry/core";

import { parseEnvelope } from "#src/parse/envelope.js";
import type { ParsedEnvelope } from "#src/parse/envelope.js";

const H = '{"event_id":"a"}';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

function parseOk(...parts: (string | Uint8Array)[]): ParsedEnvelope {
  const result = parseEnvelope(bytes(...parts));
  if (!result.ok) {
    throw new Error(`expected ok, got: ${result.error}`);
  }
  return result.envelope;
}

function text(payload: Uint8Array | undefined): string {
  return decoder.decode(payload);
}

function types(envelope: ParsedEnvelope): string[] {
  return envelope.items.map((item) => item.header.type);
}

describe("parseEnvelope", () => {
  it("parses a single event item", () => {
    const envelope = parseOk(`${H}\n{"type":"event"}\n{"x":1}\n`);
    expect(envelope.header).toEqual({ event_id: "a" });
    expect(envelope.items).toHaveLength(1);
    expect(JSON.parse(text(envelope.items[0]?.payload))).toEqual({ x: 1 });
    expect(envelope.warnings).toEqual([]);
  });

  it("accepts a missing trailing newline", () => {
    const envelope = parseOk(`${H}\n{"type":"event"}\n{"x":1}`);
    expect(envelope.items).toHaveLength(1);
    expect(text(envelope.items[0]?.payload)).toBe('{"x":1}');
    expect(envelope.warnings).toEqual([]);
  });

  it.each([H, `${H}\n`])("accepts a header-only envelope %j", (input) => {
    const envelope = parseOk(input);
    expect(envelope.items).toEqual([]);
    expect(envelope.warnings).toEqual([]);
  });

  it("parses two items without length in order", () => {
    const envelope = parseOk(
      `${H}\n{"type":"event"}\n{"x":1}\n{"type":"log","item_count":1}\n{"items":[]}\n`,
    );
    expect(types(envelope)).toEqual(["event", "log"]);
    expect(text(envelope.items[1]?.payload)).toBe('{"items":[]}');
  });

  it("parses a length 0 item followed by another item", () => {
    const envelope = parseOk(
      `${H}\n{"type":"attachment","length":0}\n\n{"type":"event"}\n{"x":1}\n`,
    );
    expect(types(envelope)).toEqual(["attachment", "event"]);
    expect(envelope.items[0]?.payload.byteLength).toBe(0);
    expect(text(envelope.items[1]?.payload)).toBe('{"x":1}');
    expect(envelope.warnings).toEqual([]);
  });

  it.each([`${H}\n{"type":"attachment","length":0}\n`, `${H}\n{"type":"attachment","length":0}`])(
    "parses a length 0 item as last item %j",
    (input) => {
      const envelope = parseOk(input);
      expect(envelope.items).toHaveLength(1);
      expect(envelope.items[0]?.payload.byteLength).toBe(0);
      expect(envelope.items[0]?.truncated).toBe(false);
    },
  );

  it("reads a binary payload containing newlines by length", () => {
    const envelope = parseOk(
      `${H}\n{"type":"attachment","length":5}\na\nb\nc\n{"type":"event"}\n{"x":1}\n`,
    );
    expect(types(envelope)).toEqual(["attachment", "event"]);
    expect(text(envelope.items[0]?.payload)).toBe("a\nb\nc");
  });

  it("returns binary payload bytes unchanged", () => {
    const binary = Uint8Array.of(0x00, 0xff, 0x0a, 0x7b);
    const envelope = parseOk(
      `${H}\n{"type":"attachment","length":4}\n`,
      binary,
      '\n{"type":"event"}\n{"x":1}\n',
    );
    expect([...(envelope.items[0]?.payload ?? [])]).toEqual([0x00, 0xff, 0x0a, 0x7b]);
    expect(types(envelope)).toEqual(["attachment", "event"]);
  });

  it("counts length in bytes for multi-byte UTF-8", () => {
    const envelope = parseOk(
      `${H}\n{"type":"attachment","length":3}\n€\n{"type":"event"}\n{"x":1}\n`,
    );
    expect(envelope.items[0]?.payload).toEqual(encoder.encode("€"));
    expect(types(envelope)).toEqual(["attachment", "event"]);
  });

  it("reads a JSON item with length", () => {
    const envelope = parseOk(`${H}\n{"type":"event","length":7}\n{"x":1}\n`);
    expect(text(envelope.items[0]?.payload)).toBe('{"x":1}');
    expect(envelope.warnings).toEqual([]);
  });

  it("handles CRLF line endings", () => {
    const envelope = parseOk(`${H}\r\n{"type":"event"}\r\n{"x":1}\r\n`);
    expect(envelope.header).toEqual({ event_id: "a" });
    expect(envelope.items).toHaveLength(1);
    expect(text(envelope.items[0]?.payload)).toBe('{"x":1}');
  });

  it("skips CRLF after a length payload", () => {
    const envelope = parseOk(
      `${H}\r\n{"type":"event","length":7}\r\n{"x":1}\r\n{"type":"event"}\r\n{"y":2}\r\n`,
    );
    expect(envelope.items.map((item) => text(item.payload))).toEqual(['{"x":1}', '{"y":2}']);
  });

  it("skips blank lines between items and at the end", () => {
    const envelope = parseOk(`${H}\n{"type":"event"}\n{"x":1}\n\n\n{"type":"event"}\n{"y":2}\n\n`);
    expect(envelope.items.map((item) => text(item.payload))).toEqual(['{"x":1}', '{"y":2}']);
    expect(envelope.warnings).toEqual([]);
  });

  it("returns an empty payload without length", () => {
    const envelope = parseOk(`${H}\n{"type":"event"}\n\n`);
    expect(envelope.items).toHaveLength(1);
    expect(envelope.items[0]?.payload.byteLength).toBe(0);
  });

  it("returns an empty payload for an item header at the end of the body", () => {
    const envelope = parseOk(`${H}\n{"type":"event"}`);
    expect(envelope.items).toHaveLength(1);
    expect(envelope.items[0]?.payload.byteLength).toBe(0);
  });

  it("truncates a payload whose length runs past the end", () => {
    const envelope = parseOk(`${H}\n{"type":"attachment","length":100}\nabc\n`);
    expect(envelope.items).toHaveLength(1);
    expect(text(envelope.items[0]?.payload)).toBe("abc\n");
    expect(envelope.items[0]?.truncated).toBe(true);
    expect(envelope.warnings).toHaveLength(1);
    expect(envelope.warnings[0]).toContain("item[0]");
    expect(envelope.warnings[0]).toContain("length 100");
  });

  it.each(["-1", "1.5", '"5"'])("treats invalid length %s as absent", (length) => {
    const envelope = parseOk(
      `${H}\n{"type":"event","length":${length}}\n{"x":1}\n{"type":"event"}\n{"y":2}\n`,
    );
    expect(envelope.items.map((item) => text(item.payload))).toEqual(['{"x":1}', '{"y":2}']);
    expect(envelope.warnings).toHaveLength(1);
    expect(envelope.warnings[0]).toContain("invalid length");
  });

  it("keeps an invalid JSON payload as raw bytes", () => {
    const envelope = parseOk(`${H}\n{"type":"event"}\n{"x":1\n{"type":"event"}\n{"y":2}\n`);
    expect(envelope.items.map((item) => text(item.payload))).toEqual(['{"x":1', '{"y":2}']);
    expect(envelope.warnings).toEqual([]);
  });

  it("stops at an invalid item header mid-envelope", () => {
    const rest = 'not json\n{"y":2}\n';
    const envelope = parseOk(`${H}\n{"type":"event"}\n{"x":1}\n${rest}`);
    expect(envelope.items).toHaveLength(1);
    expect(envelope.warnings).toHaveLength(1);
    expect(envelope.warnings[0]).toContain("item[1]");
    expect(envelope.warnings[0]).toContain(`${encoder.encode(rest).byteLength} bytes`);
  });

  it.each(['{"length":3}', "[]", '"x"', '{"type":5}'])(
    "stops at item header %s without a string type",
    (line) => {
      const envelope = parseOk(`${H}\n{"type":"event"}\n{"x":1}\n${line}\nabc\n`);
      expect(envelope.items).toHaveLength(1);
      expect(envelope.warnings).toHaveLength(1);
      expect(envelope.warnings[0]).toContain("item[1]: invalid item header");
    },
  );

  it.each([
    ["empty body", ""],
    ["not json", 'not json\n{"type":"event"}\n{}\n'],
    ["array", '[1,2]\n{"type":"event"}\n{}\n'],
    ["string", '"str"\n{"type":"event"}\n{}\n'],
    ["number", '42\n{"type":"event"}\n{}\n'],
    ["truncated JSON", '{"event_id":"a"\n{"type":"event"}\n{}\n'],
  ])("fails on an invalid envelope header: %s", (_name, input) => {
    const result = parseEnvelope(bytes(input));
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).not.toBe("");
  });

  it("accepts an empty envelope header object", () => {
    expect(parseOk("{}\n").header).toEqual({});
  });

  it("preserves unknown header fields", () => {
    const envelopeHeader = {
      event_id: "a",
      sent_at: "2026-10-03T10:00:00.000Z",
      dsn: "http://sentra@localhost:8969/1",
      sdk: { name: "sentry.javascript.node", version: "11.1.0" },
      trace: { trace_id: "t", public_key: "sentra" },
    };
    const itemHeader = {
      type: "attachment",
      length: 2,
      filename: "a.txt",
      content_type: "text/plain",
      attachment_type: "event.attachment",
      item_count: 1,
    };
    const envelope = parseOk(
      `${JSON.stringify(envelopeHeader)}\n${JSON.stringify(itemHeader)}\nab\n`,
    );
    expect(envelope.header).toEqual(envelopeHeader);
    expect(envelope.items[0]?.header).toEqual(itemHeader);
  });

  it("parses envelopes serialized by @sentry/core", () => {
    const withNewlines = encoder.encode("line1\nline2\n");
    const sentryEnvelope: Envelope = [
      { event_id: "a", sent_at: "2026-10-03T10:00:00.000Z" },
      [
        [{ type: "event" }, { event_id: "a", message: "hi" }],
        [{ type: "attachment", length: 0, filename: "empty.txt" }, new Uint8Array(0)],
        [{ type: "attachment", length: withNewlines.byteLength, filename: "nl.txt" }, withNewlines],
      ],
    ];
    const serialized = serializeEnvelope(sentryEnvelope);
    const envelope = parseOk(
      typeof serialized === "string" ? encoder.encode(serialized) : serialized,
    );
    expect(types(envelope)).toEqual(["event", "attachment", "attachment"]);
    expect(JSON.parse(text(envelope.items[0]?.payload))).toEqual({ event_id: "a", message: "hi" });
    expect(envelope.items[1]?.payload.byteLength).toBe(0);
    expect(envelope.items[2]?.payload).toEqual(withNewlines);
    expect(envelope.warnings).toEqual([]);
  });

  it("returns payload views within the input bounds", () => {
    const input = bytes(`${H}\n{"type":"attachment","length":3}\nabc\n`);
    const result = parseEnvelope(input);
    const payload = result.ok ? result.envelope.items[0]?.payload : undefined;
    expect(payload?.buffer).toBe(input.buffer);
    expect(payload?.byteOffset).toBe(input.byteLength - "abc\n".length);
    expect(payload?.byteLength).toBe(3);
    expect(text(payload)).toBe("abc");
  });

  it("parses a 20 MiB attachment quickly", () => {
    const size = 20 * 1024 * 1024;
    const big = new Uint8Array(size).fill(0x0a);
    const input = bytes(
      `${H}\n{"type":"attachment","length":${size}}\n`,
      big,
      '\n{"type":"event"}\n{"x":1}\n',
    );
    const start = performance.now();
    const envelope = parseOk(input);
    const elapsed = performance.now() - start;
    expect(envelope.items[0]?.payload.byteLength).toBe(size);
    expect(types(envelope)).toEqual(["attachment", "event"]);
    expect(elapsed).toBeLessThan(200);
  });
});
