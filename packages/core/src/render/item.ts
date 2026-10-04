import { renderStackMarkdown } from "#src/render/frames.js";
import type {
  AttachmentData,
  EventData,
  Item,
  ItemSummary,
  LogData,
  OtherData,
  Scope,
  ScopeSummary,
  SpanData,
  SpanItem,
  TransactionData,
} from "#src/types.js";
import {
  fenceFor,
  firstLine,
  indentContinuation,
  sanitizeText,
  singleLine,
} from "#src/util/text.js";

type Primitive = string | number | boolean;

const MAX_LIST = 20;
const MAX_PAYLOAD = 2000;
const DEFAULT_ATTRIBUTES_LENGTH = 120;

function formatScope(scope: Scope): string {
  const parts = [scope.project, scope.session, scope.service].filter((part) => part !== "default");
  return parts.length === 0 ? "default" : parts.join("/");
}

function fullScope(scope: Scope): string {
  return `${scope.project}/${scope.session}/${scope.service}`;
}

function formatRelativeTime(iso: string, now: Date): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) {
    return iso;
  }
  const seconds = Math.max(0, Math.floor((now.getTime() - time) / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ago`;
  }
  if (seconds < 86_400) {
    return `${Math.floor(seconds / 3600)}h ago`;
  }
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function formatDuration(ms: number): string {
  const rounded = Math.round(ms);
  return rounded < 1000 ? `${rounded}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function formatAttributes(
  attributes: Record<string, Primitive>,
  maxLength = DEFAULT_ATTRIBUTES_LENGTH,
): string {
  const entries = Object.entries(attributes);
  if (entries.length === 0) {
    return "";
  }
  const inner = entries.map(([key, value]) => `${key}: ${String(value)}`).join(", ");
  const text = `{${singleLine(inner)}}`;
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 2))}…}` : text;
}

function renderItemLine(item: ItemSummary): string {
  return [
    item.timestamp,
    item.kind,
    item.level ?? "-",
    formatScope(item.scope),
    `${firstLine(item.title)} [${item.id}]`,
  ].join(" ");
}

/** `key: value`; multi-line values are indented so they cannot fake markdown sections. */
function field(key: string, value: Primitive): string {
  return `${singleLine(key)}: ${indentContinuation(String(value))}`;
}

/** `key: value` lines, skipping `null` values. */
function fieldLines(fields: [string, Primitive | null][]): string[] {
  return fields.flatMap(([key, value]) => (value === null ? [] : [field(key, value)]));
}

function section(title: string, body: string[]): string[] {
  return body.length === 0 ? [] : ["", `## ${title}`, ...body];
}

function keyValueLines(record: Record<string, Primitive>): string[] {
  return Object.entries(record).map(([key, value]) => field(key, value));
}

function headerLines(item: Item): string[] {
  return fieldLines([
    ["id", item.id],
    ["eventId", item.eventId],
    ["kind", item.kind],
    ["level", item.level],
    ["scope", fullScope(item.scope)],
    ["timestamp", item.timestamp],
    ["issue", item.issueId],
    ["environment", item.environment],
    ["release", item.release],
    ["trace", item.traceId],
  ]);
}

function exceptionTitle(type: string | null, value: string | null): string {
  if (type !== null && value !== null) {
    return `${singleLine(type)}: ${firstLine(value)}`;
  }
  if (type !== null) {
    return singleLine(type);
  }
  return value === null ? "Exception" : firstLine(value);
}

/** Lines after the first of an exception value, indented below the heading. */
function valueContinuation(value: string | null): string[] {
  const clean = value === null ? "" : sanitizeText(value);
  const rest = clean.includes("\n") ? clean.slice(clean.indexOf("\n") + 1).trimEnd() : "";
  return rest === "" ? [] : [`    ${indentContinuation(rest)}`];
}

function eventLines(data: EventData): string[] {
  const lines = fieldLines([["message", data.message]]);
  for (const exception of data.exceptions.toReversed()) {
    const stack = renderStackMarkdown(exception.frames);
    lines.push(
      "",
      `## ${exceptionTitle(exception.type, exception.value)}`,
      ...valueContinuation(exception.value),
      ...(stack === "" ? [] : [stack]),
    );
  }
  if (data.stacktrace.length > 0) {
    lines.push(...section("Stack", [renderStackMarkdown(data.stacktrace)]));
  }
  const request = singleLine(
    [data.request?.method, data.request?.url]
      .filter((part) => part !== null && part !== undefined)
      .join(" "),
  );
  lines.push(...section("Request", request === "" ? [] : [request]));
  lines.push(...section("Tags", keyValueLines(data.tags)));
  lines.push(
    ...section(
      "Breadcrumbs",
      data.breadcrumbs
        .slice(-MAX_LIST)
        .map((crumb) =>
          [
            crumb.timestamp ?? "-",
            crumb.category ?? crumb.type ?? "-",
            crumb.level ?? "-",
            firstLine(crumb.message ?? ""),
          ]
            .map(singleLine)
            .join(" ")
            .trimEnd(),
        ),
    ),
  );
  const { sourceMaps } = data;
  lines.push(
    ...section("Source maps", [
      `status: ${sourceMaps.status}`,
      `mapped: ${sourceMaps.mappedFrames}/${sourceMaps.candidateFrames}`,
      ...sourceMaps.errors.map((error) => singleLine(`- ${error.absPath}: ${error.reason}`)),
    ]),
  );
  return lines;
}

function longest<T extends { durationMs: number }>(entries: T[]): T[] {
  return entries.toSorted((a, b) => b.durationMs - a.durationMs).slice(0, MAX_LIST);
}

function truncatedNote(shown: number, total: number, noun: string): string[] {
  return shown < total ? [`(${shown} of ${total} ${noun})`] : [];
}

function transactionLines(data: TransactionData): string[] {
  const spans = longest(data.spans);
  return [
    ...fieldLines([
      ["name", data.name],
      ["op", data.op],
      ["status", data.status],
      ["duration", formatDuration(data.durationMs)],
    ]),
    ...section("Spans", [
      ...spans.map((span) =>
        `${formatDuration(span.durationMs)} ${singleLine(span.op ?? "-")} ${firstLine(span.description ?? "")}`.trimEnd(),
      ),
      ...truncatedNote(spans.length, data.spans.length, "spans"),
    ]),
  ];
}

interface TraceSpans {
  spans: SpanItem[];
  /** Spans scanned. */
  total: number;
  /** The scan stopped before the end of the trace. */
  truncated: boolean;
}

function spanLines(data: SpanData, trace: TraceSpans): string[] {
  const traceSpans = trace.spans;
  const longestSpans = longest(
    traceSpans.map((span) => ({ span, durationMs: span.data.durationMs })),
  );
  return [
    ...fieldLines([
      ["name", data.name],
      ["op", data.op],
      ["duration", formatDuration(data.durationMs)],
      ["status", data.status],
      ["spanId", data.spanId],
      ["parentSpanId", data.parentSpanId],
    ]),
    ...section("Attributes", keyValueLines(data.attributes)),
    ...section("Trace spans", [
      ...longestSpans.map(
        ({ span }) =>
          `${formatDuration(span.data.durationMs)} ${singleLine(span.data.op ?? "-")} ${firstLine(span.data.name)} [${span.id}]`,
      ),
      ...(trace.truncated
        ? [
            `(${longestSpans.length} longest of the newest ${trace.total} spans; the trace has more)`,
          ]
        : truncatedNote(longestSpans.length, trace.total, "spans")),
    ]),
  ];
}

function logLines(data: LogData): string[] {
  return [field("body", data.body), ...section("Attributes", keyValueLines(data.attributes))];
}

function attachmentLines(data: AttachmentData): string[] {
  return fieldLines([
    ["filename", data.filename],
    ["contentType", data.contentType],
    ["attachmentType", data.attachmentType],
    ["size", data.size],
    ["stored", data.stored],
  ]);
}

function payloadText(payload: unknown): string | null {
  if (typeof payload === "string") {
    return payload;
  }
  return JSON.stringify(payload, null, 2) ?? null;
}

function fenced(text: string): string[] {
  const fence = fenceFor(text.split("\n"));
  return [fence, text, fence];
}

function otherLines(itemType: string, data: OtherData): string[] {
  const payload = payloadText(data.payload);
  const shown =
    payload !== null && payload.length > MAX_PAYLOAD
      ? `${payload.slice(0, MAX_PAYLOAD)}…`
      : payload;
  return [
    ...fieldLines([
      ["itemType", itemType],
      ["payloadEncoding", data.payloadEncoding],
      ["size", data.size],
      ["normalizeError", data.normalizeError],
    ]),
    ...section("Payload", shown === null ? [] : fenced(shown)),
  ];
}

function kindLines(item: Item, trace: TraceSpans): string[] {
  switch (item.kind) {
    case "error":
    case "message": {
      return eventLines(item.data);
    }
    case "transaction": {
      return transactionLines(item.data);
    }
    case "span": {
      return spanLines(item.data, trace);
    }
    case "log": {
      return logLines(item.data);
    }
    case "attachment": {
      return attachmentLines(item.data);
    }
    case "other": {
      return otherLines(item.itemType, item.data);
    }
    default: {
      return item satisfies never;
    }
  }
}

function renderItemDetail(
  item: Item,
  context: { traceSpans?: SpanItem[]; traceSpanTotal?: number; traceSpansTruncated?: boolean } = {},
): string {
  const spans = context.traceSpans ?? [];
  const trace = {
    spans,
    total: context.traceSpanTotal ?? spans.length,
    truncated: context.traceSpansTruncated ?? false,
  };
  return sanitizeText([...headerLines(item), ...kindLines(item, trace)].join("\n"));
}

function renderScopeTable(scopes: ScopeSummary[]): string {
  if (scopes.length === 0) {
    return "No scopes.";
  }
  const rows = scopes.map(
    (scope) =>
      `| ${fullScope(scope)} | ${scope.lastSeenAt} | ${scope.itemCount} | ${scope.issueCount} |`,
  );
  return sanitizeText(
    ["| scope | lastSeenAt | items | issues |", "| --- | --- | --- | --- |", ...rows].join("\n"),
  );
}

export {
  formatAttributes,
  formatDuration,
  formatRelativeTime,
  formatScope,
  renderItemDetail,
  renderItemLine,
  renderScopeTable,
};
