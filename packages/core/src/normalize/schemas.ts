import { array, boolean, looseObject, number, record, string, union, unknown } from "zod";
import type { ZodType, output } from "zod";

import { normalizeLevel } from "#src/normalize/level.js";
import { parseTimestampMs, toIso } from "#src/normalize/time.js";
import type { Breadcrumb, RequestInfo } from "#src/types.js";

/** Missing, `null` or invalid input → `undefined` instead of failing the parent. */
function lenient<T extends ZodType>(schema: T) {
  return unknown()
    .optional()
    .transform((value) => {
      const parsed = schema.safeParse(value);
      return parsed.success ? (parsed.data ?? undefined) : undefined;
    });
}

/** Array whose invalid entries are dropped one by one; non-array → `undefined`. */
function lenientArray<T extends ZodType>(schema: T) {
  return lenient(
    array(unknown()).transform((list) =>
      list.flatMap((entry): output<T>[] => {
        const parsed = schema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      }),
    ),
  );
}

/** Object whose invalid values are dropped key by key; non-object → `undefined`. */
function lenientRecord<T extends ZodType>(schema: T) {
  return lenient(
    record(string(), unknown()).transform((input) =>
      Object.fromEntries(
        Object.entries(input).flatMap(([key, value]): [string, output<T>][] => {
          const parsed = schema.safeParse(value);
          return parsed.success ? [[key, parsed.data]] : [];
        }),
      ),
    ),
  );
}

/** Keys present (non-nullish) in `input` that were dropped by lenient parsing. */
function collectDropped(
  input: Record<string, unknown>,
  parsed: Record<string, unknown>,
  keys: readonly string[],
): string[] {
  return keys.filter(
    (key) => input[key] !== undefined && input[key] !== null && parsed[key] === undefined,
  );
}

const EVENT_ID_PATTERN = /^[0-9a-f]{32}$/;

function normalizeEventId(input: unknown): string | null {
  if (typeof input !== "string") {
    return null;
  }
  const id = input.replaceAll("-", "").toLowerCase();
  return EVENT_ID_PATTERN.test(id) ? id : null;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  if (max < 1) {
    return "";
  }
  let end = Math.max(0, max - 1);
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd8_00 && code <= 0xdb_ff) {
    end -= 1;
  }
  return `${text.slice(0, end)}…`;
}

const objectSchema = record(string(), unknown());
const timestampSchema = union([number(), string()]);
const primitiveSchema = union([string(), number(), boolean()]);

function stringifyTagValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return undefined;
}

const tagsSchema = union([array(unknown()), objectSchema]).transform((input) => {
  const entries: [unknown, unknown][] = Array.isArray(input)
    ? input.flatMap((pair): [unknown, unknown][] =>
        Array.isArray(pair) && pair.length === 2 ? [[pair[0], pair[1]]] : [],
      )
    : Object.entries(input);
  const tags: Record<string, string> = {};
  for (const [key, value] of entries) {
    const text = stringifyTagValue(value);
    if (typeof key === "string" && text !== undefined) {
      tags[key] = text;
    }
  }
  return tags;
});

const breadcrumbEntrySchema = looseObject({
  timestamp: lenient(timestampSchema),
  type: lenient(string()),
  category: lenient(string()),
  level: lenient(string()),
  message: lenient(string()),
  data: lenient(objectSchema),
});

const breadcrumbsSchema = union([
  array(unknown()),
  looseObject({ values: array(unknown()) }),
]).transform((input): Breadcrumb[] => {
  const values = Array.isArray(input) ? input : input.values;
  return values.flatMap((entry): Breadcrumb[] => {
    const parsed = breadcrumbEntrySchema.safeParse(entry);
    if (!parsed.success) {
      return [];
    }
    const crumb = parsed.data;
    const ms = parseTimestampMs(crumb.timestamp);
    return [
      {
        timestamp: ms === null ? null : toIso(ms),
        type: crumb.type ?? null,
        category: crumb.category ?? null,
        level: normalizeLevel(crumb.level),
        message: crumb.message ?? null,
        data: crumb.data ?? null,
      },
    ];
  });
});

function serializeQuery(input: string | Record<string, unknown> | unknown[]): string | null {
  if (typeof input === "string") {
    return input === "" ? null : input;
  }
  const params = new URLSearchParams();
  const entries: unknown[] = Array.isArray(input) ? input : Object.entries(input);
  for (const pair of entries) {
    if (Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string") {
      params.append(pair[0], pair[1]);
    }
  }
  const query = params.toString();
  return query === "" ? null : query;
}

const requestSchema = looseObject({
  method: lenient(string()),
  url: lenient(string()),
  headers: lenient(objectSchema),
  query_string: lenient(union([string(), objectSchema, array(unknown())])),
  data: unknown().optional(),
}).transform((request): RequestInfo => ({
  method: request.method ?? null,
  url: request.url ?? null,
  headers: Object.fromEntries(
    Object.entries(request.headers ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  ),
  query: request.query_string === undefined ? null : serializeQuery(request.query_string),
  data: request.data ?? null,
}));

const sdkSchema = looseObject({
  name: lenient(string()),
  version: lenient(string()),
}).transform((sdk) =>
  sdk.name !== undefined && sdk.version !== undefined
    ? { name: sdk.name, version: sdk.version }
    : undefined,
);

const typedAttributeSchema = looseObject({
  value: lenient(primitiveSchema),
  type: lenient(string()),
});

const rawFrameSchema = looseObject({
  filename: lenient(string()),
  abs_path: lenient(string()),
  function: lenient(string()),
  module: lenient(string()),
  lineno: lenient(number()),
  colno: lenient(number()),
  in_app: lenient(boolean()),
  context_line: lenient(string()),
  pre_context: lenient(array(string())),
  post_context: lenient(array(string())),
});

const stacktraceSchema = looseObject({
  frames: lenientArray(rawFrameSchema),
});

const mechanismSchema = looseObject({
  type: lenient(string()),
  handled: lenient(boolean()),
});

const exceptionValueSchema = looseObject({
  type: lenient(string()),
  value: lenient(string()),
  module: lenient(string()),
  mechanism: lenient(mechanismSchema),
  stacktrace: lenient(stacktraceSchema),
});

const threadSchema = looseObject({
  id: lenient(union([number(), string()])),
  name: lenient(string()),
  crashed: lenient(boolean()),
  current: lenient(boolean()),
  stacktrace: lenient(stacktraceSchema),
});

const logEntryMessageSchema = looseObject({
  formatted: lenient(string()),
  message: lenient(string()),
});

const commonEventShape = {
  event_id: lenient(string()),
  timestamp: lenient(timestampSchema),
  platform: lenient(string()),
  environment: lenient(string()),
  release: lenient(string()),
  dist: lenient(string()),
  server_name: lenient(string()),
  transaction: lenient(string()),
  user: lenient(objectSchema),
  request: lenient(requestSchema),
  tags: lenient(tagsSchema),
  contexts: lenient(objectSchema),
  extra: lenient(objectSchema),
  breadcrumbs: lenient(breadcrumbsSchema),
  sdk: lenient(sdkSchema),
};

const eventPayloadSchema = looseObject({
  ...commonEventShape,
  level: lenient(string()),
  logger: lenient(string()),
  culprit: lenient(string()),
  message: lenient(union([string(), logEntryMessageSchema])),
  logentry: lenient(logEntryMessageSchema),
  exception: lenient(looseObject({ values: lenientArray(exceptionValueSchema) })),
  stacktrace: lenient(stacktraceSchema),
  threads: lenient(looseObject({ values: lenientArray(threadSchema) })),
  fingerprint: lenient(array(string())),
});

const traceContextSchema = looseObject({
  trace_id: lenient(string()),
  span_id: lenient(string()),
  parent_span_id: lenient(string()),
  op: lenient(string()),
  status: lenient(string()),
});

/** `contexts.trace` of an event or transaction. */
const contextsSchema = looseObject({ trace: lenient(traceContextSchema) });

const transactionSpanSchema = looseObject({
  span_id: lenient(string()),
  parent_span_id: lenient(string()),
  op: lenient(string()),
  description: lenient(string()),
  status: lenient(string()),
  start_timestamp: lenient(timestampSchema),
  timestamp: lenient(timestampSchema),
});

const measurementSchema = looseObject({
  value: lenient(number()),
  unit: lenient(string()),
});

const transactionPayloadSchema = looseObject({
  ...commonEventShape,
  start_timestamp: lenient(timestampSchema),
  spans: lenientArray(transactionSpanSchema),
  measurements: lenientRecord(measurementSchema),
});

const spanContainerSchema = looseObject({ items: array(unknown()) });

const spanEntrySchema = looseObject({
  name: lenient(string()),
  span_id: lenient(string()),
  parent_span_id: lenient(string()),
  trace_id: lenient(string()),
  is_segment: lenient(boolean()),
  status: lenient(string()),
  start_timestamp: lenient(timestampSchema),
  end_timestamp: lenient(timestampSchema),
  attributes: lenient(objectSchema),
});

const logContainerSchema = looseObject({ items: array(unknown()) });

const logEntrySchema = looseObject({
  timestamp: lenient(timestampSchema),
  level: lenient(string()),
  body: lenient(string()),
  trace_id: lenient(string()),
  span_id: lenient(string()),
  severity_number: lenient(number()),
  attributes: lenient(objectSchema),
});

export {
  contextsSchema,
  traceContextSchema,
  lenientArray,
  lenientRecord,
  lenient,
  collectDropped,
  normalizeEventId,
  truncate,
  tagsSchema,
  breadcrumbsSchema,
  requestSchema,
  sdkSchema,
  typedAttributeSchema,
  rawFrameSchema,
  stacktraceSchema,
  exceptionValueSchema,
  eventPayloadSchema,
  transactionSpanSchema,
  transactionPayloadSchema,
  spanContainerSchema,
  spanEntrySchema,
  logContainerSchema,
  logEntrySchema,
};
