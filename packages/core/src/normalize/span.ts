import { flattenAttributes } from "#src/normalize/attributes.js";
import { otherFromEntry } from "#src/normalize/other.js";
import { spanContainerSchema, spanEntrySchema, truncate } from "#src/normalize/schemas.js";
import { ITEM_TITLE_MAX, baseSummary, stringAttribute } from "#src/normalize/summary.js";
import { durationMs, toIsoTimestamp } from "#src/normalize/time.js";
import type { NewItem, NormalizeContext, NormalizeResult } from "#src/normalize/types.js";
import type { SpanData } from "#src/types.js";

const UNNAMED = "<unnamed span>";

function normalizeSpanEntry(entry: unknown, ctx: NormalizeContext): NewItem {
  const parsed = spanEntrySchema.safeParse(entry);
  if (!parsed.success) {
    return otherFromEntry("span", entry, ctx, "span entry is not a JSON object");
  }
  const span = parsed.data;
  if (span.span_id === undefined) {
    return otherFromEntry("span", entry, ctx, "span entry has no string span_id");
  }
  const attributes = flattenAttributes(span.attributes);
  const timestamp = toIsoTimestamp(span.end_timestamp, ctx.receivedAt);
  const name = span.name ?? UNNAMED;
  const data: SpanData = {
    name,
    spanId: span.span_id,
    parentSpanId: span.parent_span_id ?? null,
    isSegment: span.is_segment === true,
    status: span.status ?? null,
    startTimestamp: toIsoTimestamp(span.start_timestamp, timestamp),
    durationMs: durationMs(span.start_timestamp, span.end_timestamp),
    op: stringAttribute(attributes, "sentry.op"),
    attributes,
  };
  const summary = baseSummary(ctx, {
    itemType: "span",
    timestamp,
    traceId: span.trace_id ?? null,
    environment: stringAttribute(attributes, "sentry.environment"),
    release: stringAttribute(attributes, "sentry.release"),
    title: truncate(name, ITEM_TITLE_MAX),
  });
  return { item: { ...summary, kind: "span", data }, blob: null, grouping: null, warnings: [] };
}

/** Span v2 container: one record per entry. */
function normalizeSpans(payload: unknown, ctx: NormalizeContext): NormalizeResult {
  const container = spanContainerSchema.safeParse(payload);
  if (!container.success) {
    return { ok: false, error: "span payload has no items array" };
  }
  return { ok: true, items: container.data.items.map((entry) => normalizeSpanEntry(entry, ctx)) };
}

export { normalizeSpans };
