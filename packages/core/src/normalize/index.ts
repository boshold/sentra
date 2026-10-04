import { normalizeAttachment } from "#src/normalize/attachment.js";
import { normalizeEvent } from "#src/normalize/event.js";
import { normalizeLogs } from "#src/normalize/log.js";
import { decodeText, normalizeOther } from "#src/normalize/other.js";
import { normalizeSpans } from "#src/normalize/span.js";
import { normalizeTransaction } from "#src/normalize/transaction.js";
import type { NewItem, NormalizeContext, NormalizeResult } from "#src/normalize/types.js";
import type { ParsedEnvelope, ParsedItem } from "#src/parse/envelope.js";
import { messageOf } from "#src/util/error.js";

type JsonNormalizer = (payload: unknown, ctx: NormalizeContext) => NormalizeResult;

const JSON_NORMALIZERS: ReadonlyMap<string, JsonNormalizer> = new Map([
  ["event", normalizeEvent],
  ["transaction", normalizeTransaction],
  ["span", normalizeSpans],
  ["log", normalizeLogs],
]);

type JsonResult = { ok: true; value: unknown } | { ok: false; error: string };

function parseJson(bytes: Uint8Array): JsonResult {
  const text = decodeText(bytes);
  if (text === null) {
    return { ok: false, error: "payload is not valid UTF-8" };
  }
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${messageOf(error)}` };
  }
}

function normalizeItem(item: ParsedItem, ctx: NormalizeContext): NewItem[] {
  if (item.truncated) {
    return [normalizeOther(item, ctx, "payload truncated")];
  }
  if (item.header.type === "attachment") {
    return [normalizeAttachment(item, ctx)];
  }
  const normalizer = JSON_NORMALIZERS.get(item.header.type);
  if (normalizer === undefined) {
    return [normalizeOther(item, ctx)];
  }
  const json = parseJson(item.payload);
  if (!json.ok) {
    return [normalizeOther(item, ctx, json.error)];
  }
  const result = normalizer(json.value, ctx);
  return result.ok ? result.items : [normalizeOther(item, ctx, result.error)];
}

/** Turns every parsed item into records, in envelope order. Never throws. */
function normalizeItems(parsed: ParsedEnvelope, ctx: NormalizeContext): NewItem[] {
  return parsed.items.flatMap((item) => {
    try {
      return normalizeItem(item, ctx);
    } catch (error) {
      return [normalizeOther(item, ctx, messageOf(error))];
    }
  });
}

export { normalizeItems };
export type { NewItem, NormalizeContext, NormalizeResult } from "#src/normalize/types.js";
