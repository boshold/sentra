import { flattenAttributes } from "#src/normalize/attributes.js";
import { normalizeLevel } from "#src/normalize/level.js";
import { otherFromEntry } from "#src/normalize/other.js";
import { logContainerSchema, logEntrySchema, truncate } from "#src/normalize/schemas.js";
import { ITEM_TITLE_MAX, baseSummary, stringAttribute } from "#src/normalize/summary.js";
import { toIsoTimestamp } from "#src/normalize/time.js";
import type { NewItem, NormalizeContext, NormalizeResult } from "#src/normalize/types.js";
import type { LogData } from "#src/types.js";

function normalizeLogEntry(entry: unknown, ctx: NormalizeContext): NewItem {
  const parsed = logEntrySchema.safeParse(entry);
  if (!parsed.success) {
    return otherFromEntry("log", entry, ctx, "log entry is not a JSON object");
  }
  const log = parsed.data;
  if (log.body === undefined) {
    return otherFromEntry("log", entry, ctx, "log entry has no string body");
  }
  const attributes = flattenAttributes(log.attributes);
  const data: LogData = {
    body: log.body,
    severityNumber: log.severity_number ?? null,
    spanId: log.span_id ?? stringAttribute(attributes, "sentry.trace.parent_span_id"),
    attributes,
  };
  const summary = baseSummary(ctx, {
    itemType: "log",
    timestamp: toIsoTimestamp(log.timestamp, ctx.receivedAt),
    traceId: log.trace_id ?? null,
    level: normalizeLevel(log.level) ?? "info",
    environment: stringAttribute(attributes, "sentry.environment"),
    release: stringAttribute(attributes, "sentry.release"),
    title: truncate(log.body, ITEM_TITLE_MAX),
  });
  return { item: { ...summary, kind: "log", data }, blob: null, grouping: null, warnings: [] };
}

/** Log container: one record per entry. */
function normalizeLogs(payload: unknown, ctx: NormalizeContext): NormalizeResult {
  const container = logContainerSchema.safeParse(payload);
  if (!container.success) {
    return { ok: false, error: "log payload has no items array" };
  }
  return { ok: true, items: container.data.items.map((entry) => normalizeLogEntry(entry, ctx)) };
}

export { normalizeLogs };
