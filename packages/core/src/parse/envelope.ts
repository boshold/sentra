import { z } from "zod";

interface ParsedItem {
  header: Record<string, unknown> & { type: string };
  payload: Uint8Array;
  /** `true` when `length` exceeded the remaining bytes. */
  truncated: boolean;
}

interface ParsedEnvelope {
  header: Record<string, unknown>;
  items: ParsedItem[];
  warnings: string[];
}

type ParseEnvelopeResult = { ok: true; envelope: ParsedEnvelope } | { ok: false; error: string };

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

const envelopeHeaderSchema = z.looseObject({});
const itemHeaderSchema = z.looseObject({ type: z.string() });
const lengthSchema = z.number().int().nonnegative();

const decoder = new TextDecoder();

class Cursor {
  readonly #bytes: Uint8Array;
  #pos = 0;

  public constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  public get position(): number {
    return this.#pos;
  }

  public get remaining(): number {
    return this.#bytes.byteLength - this.#pos;
  }

  /** Bytes up to the next `\n` (exclusive, trailing `\r` stripped); advances past the `\n`. */
  public readLine(): Uint8Array {
    const start = this.#pos;
    const newline = this.#bytes.indexOf(NEWLINE, start);
    const end = newline === -1 ? this.#bytes.byteLength : newline;
    this.#pos = newline === -1 ? end : end + 1;
    const contentEnd = end > start && this.#bytes[end - 1] === CARRIAGE_RETURN ? end - 1 : end;
    return this.#bytes.subarray(start, contentEnd);
  }

  public readBytes(count: number): Uint8Array {
    const start = this.#pos;
    this.#pos = Math.min(start + count, this.#bytes.byteLength);
    return this.#bytes.subarray(start, this.#pos);
  }

  /** Consumes one `\n` or `\r\n` if present. */
  public skipNewline(): void {
    if (this.#bytes[this.#pos] === NEWLINE) {
      this.#pos += 1;
    } else if (
      this.#bytes[this.#pos] === CARRIAGE_RETURN &&
      this.#bytes[this.#pos + 1] === NEWLINE
    ) {
      this.#pos += 2;
    }
  }
}

function parseJsonLine(
  line: Uint8Array,
): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    const value: unknown = JSON.parse(decoder.decode(line));
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

function parseItems(cursor: Cursor, items: ParsedItem[], warnings: string[]): void {
  while (cursor.remaining > 0) {
    const lineStart = cursor.position;
    const line = cursor.readLine();
    if (line.byteLength === 0) {
      continue;
    }
    const index = items.length;
    const json = parseJsonLine(line);
    const parsedHeader = json.ok ? itemHeaderSchema.safeParse(json.value) : null;
    if (!parsedHeader?.success) {
      const unparsed = cursor.remaining + (cursor.position - lineStart);
      warnings.push(`item[${index}]: invalid item header, ${unparsed} bytes left unparsed`);
      return;
    }
    const header = parsedHeader.data;
    const length = lengthSchema.safeParse(header.length);
    if (length.success) {
      const { remaining } = cursor;
      const truncated = length.data > remaining;
      if (truncated) {
        warnings.push(
          `item[${index}]: length ${length.data} exceeds remaining ${remaining} bytes, payload truncated`,
        );
      }
      const payload = cursor.readBytes(length.data);
      cursor.skipNewline();
      items.push({ header, payload, truncated });
      continue;
    }
    if (header.length !== undefined) {
      warnings.push(`item[${index}]: invalid length, reading to end of line`);
    }
    items.push({ header, payload: cursor.readLine(), truncated: false });
  }
}

/** Parses Sentry envelope bytes. Never throws; only an invalid envelope header fails the parse. */
export function parseEnvelope(body: Uint8Array): ParseEnvelopeResult {
  if (body.byteLength === 0) {
    return { ok: false, error: "empty envelope" };
  }
  const cursor = new Cursor(body);
  const json = parseJsonLine(cursor.readLine());
  if (!json.ok) {
    return { ok: false, error: `envelope header is not valid JSON: ${json.error}` };
  }
  const header = envelopeHeaderSchema.safeParse(json.value);
  if (!header.success) {
    return { ok: false, error: "envelope header is not a JSON object" };
  }
  const items: ParsedItem[] = [];
  const warnings: string[] = [];
  parseItems(cursor, items, warnings);
  return { ok: true, envelope: { header: header.data, items, warnings } };
}

export type { ParsedEnvelope, ParsedItem, ParseEnvelopeResult };
