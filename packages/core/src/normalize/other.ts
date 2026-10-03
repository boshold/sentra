import { record, string, unknown } from "zod";

import { normalizeEventId, truncate } from "#src/normalize/schemas.js";
import { baseSummary } from "#src/normalize/summary.js";
import { toIsoTimestamp } from "#src/normalize/time.js";
import type { NewItem, NormalizeContext } from "#src/normalize/types.js";
import type { ParsedItem } from "#src/parse/envelope.js";
import type { OtherData } from "#src/types.js";

const TITLE_MAX = 500;

const utf8 = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const payloadObjectSchema = record(string(), unknown());

type Decoded =
  | { encoding: "json"; value: unknown }
  | { encoding: "text"; value: string }
  | { encoding: "binary" };

function decodeText(bytes: Uint8Array): string | null {
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

function decodePayload(bytes: Uint8Array): Decoded {
  const text = decodeText(bytes);
  if (text === null) {
    return { encoding: "binary" };
  }
  try {
    const value: unknown = JSON.parse(text);
    return { encoding: "json", value };
  } catch {
    return { encoding: "text", value: text };
  }
}

function otherRecord(
  ctx: NormalizeContext,
  itemType: string,
  data: OtherData,
  blob: Uint8Array | null,
): NewItem {
  const object = payloadObjectSchema.safeParse(data.payload);
  const json = data.payloadEncoding === "json" && object.success ? object.data : null;
  const summary = baseSummary(ctx, {
    itemType,
    timestamp: toIsoTimestamp(json?.timestamp, ctx.receivedAt),
    eventId: normalizeEventId(json?.event_id),
    title: truncate(itemType, TITLE_MAX),
  });
  return { item: { ...summary, kind: "other", data }, blob, grouping: null, warnings: [] };
}

/** Any item that is not typed: JSON, text or binary payload. */
function normalizeOther(item: ParsedItem, ctx: NormalizeContext, normalizeError?: string): NewItem {
  const decoded = decodePayload(item.payload);
  const data: OtherData = {
    payloadEncoding: decoded.encoding,
    payload: decoded.encoding === "binary" ? null : decoded.value,
    size: item.payload.byteLength,
    normalizeError: normalizeError ?? null,
  };
  return otherRecord(
    ctx,
    item.header.type,
    data,
    decoded.encoding === "binary" ? item.payload : null,
  );
}

/** A single span/log container entry that could not be typed. */
function otherFromEntry(
  itemType: string,
  entry: unknown,
  ctx: NormalizeContext,
  normalizeError: string,
): NewItem {
  const data: OtherData = {
    payloadEncoding: "json",
    payload: entry,
    size: encoder.encode(JSON.stringify(entry) ?? "").byteLength,
    normalizeError,
  };
  return otherRecord(ctx, itemType, data, null);
}

export { decodeText, normalizeOther, otherFromEntry };
