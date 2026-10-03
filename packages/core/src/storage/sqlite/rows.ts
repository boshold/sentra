import {
  NEVER,
  array,
  boolean,
  discriminatedUnion,
  instanceof as instanceOf,
  int,
  literal,
  nullable,
  number,
  object,
  record,
  string,
  union,
  unknown,
} from "zod";
import type { ZodType, output } from "zod";

import { toIso } from "#src/normalize/time.js";
import type { SqliteParam } from "#src/storage/sqlite/driver/types.js";
import { ITEM_KINDS, LEVELS } from "#src/types.js";
import type { Envelope, Issue, Item, ItemSummary, Level, ScopeSummary } from "#src/types.js";

const SHORT_ID_LENGTH = 8;

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

/** JSON text column decoded and validated by `schema`. */
function jsonColumn<T extends ZodType>(schema: T) {
  return string()
    .transform((text, ctx): unknown => {
      try {
        return parseJson(text);
      } catch {
        ctx.addIssue({ code: "custom", message: "invalid JSON" });
        return NEVER;
      }
    })
    .pipe(schema);
}

function toMs(iso: string): number {
  return Date.parse(iso);
}

const nullableString = nullable(string());
const levelSchema = literal(LEVELS);
const jsonRecordSchema = record(string(), unknown());
const attributesSchema = record(string(), union([string(), number(), boolean()]));
const sdkSchema = nullable(object({ name: string(), version: string() }));

const requestSchema = nullable(
  object({
    method: nullableString,
    url: nullableString,
    headers: record(string(), string()),
    query: nullableString,
    data: unknown(),
  }),
);

const mappedLocationSchema = object({
  source: string(),
  absPath: nullableString,
  lineno: number(),
  colno: nullable(number()),
  function: nullableString,
  contextLine: nullableString,
  preContext: array(string()),
  postContext: array(string()),
});

const frameSchema = object({
  filename: nullableString,
  absPath: nullableString,
  function: nullableString,
  module: nullableString,
  lineno: nullable(number()),
  colno: nullable(number()),
  inApp: boolean(),
  contextLine: nullableString,
  preContext: array(string()),
  postContext: array(string()),
  positionReliable: boolean(),
  mapped: nullable(mappedLocationSchema),
});

const eventDataSchema = object({
  message: nullableString,
  exceptions: array(
    object({
      type: nullableString,
      value: nullableString,
      module: nullableString,
      mechanism: nullable(object({ type: string(), handled: nullable(boolean()) })),
      frames: array(frameSchema),
    }),
  ),
  stacktrace: array(frameSchema),
  culprit: nullableString,
  transaction: nullableString,
  logger: nullableString,
  dist: nullableString,
  serverName: nullableString,
  user: nullable(jsonRecordSchema),
  request: requestSchema,
  tags: record(string(), string()),
  contexts: jsonRecordSchema,
  extra: jsonRecordSchema,
  breadcrumbs: array(
    object({
      timestamp: nullableString,
      type: nullableString,
      category: nullableString,
      level: nullable(levelSchema),
      message: nullableString,
      data: nullable(jsonRecordSchema),
    }),
  ),
  sdk: sdkSchema,
  fingerprint: array(string()),
  sourceMaps: object({
    status: literal(["not_applicable", "none", "partial", "full"]),
    mappedFrames: number(),
    candidateFrames: number(),
    errors: array(object({ absPath: string(), reason: string() })),
  }),
});

const transactionDataSchema = object({
  name: string(),
  op: nullableString,
  status: nullableString,
  startTimestamp: string(),
  durationMs: number(),
  spanId: nullableString,
  parentSpanId: nullableString,
  spans: array(
    object({
      spanId: string(),
      parentSpanId: nullableString,
      op: nullableString,
      description: nullableString,
      status: nullableString,
      startTimestamp: string(),
      durationMs: number(),
    }),
  ),
  measurements: record(string(), object({ value: number(), unit: nullableString })),
  tags: record(string(), string()),
  contexts: jsonRecordSchema,
  request: requestSchema,
  sdk: sdkSchema,
});

const spanDataSchema = object({
  name: string(),
  spanId: string(),
  parentSpanId: nullableString,
  isSegment: boolean(),
  status: nullableString,
  startTimestamp: string(),
  durationMs: number(),
  op: nullableString,
  attributes: attributesSchema,
});

const logDataSchema = object({
  body: string(),
  severityNumber: nullable(number()),
  spanId: nullableString,
  attributes: attributesSchema,
});

const attachmentDataSchema = object({
  filename: string(),
  contentType: nullableString,
  attachmentType: nullableString,
  size: number(),
  stored: boolean(),
});

const otherDataSchema = object({
  payloadEncoding: literal(["json", "text", "binary"]),
  payload: unknown(),
  size: number(),
  normalizeError: nullableString,
});

const scopeRowSchema = object({
  project: string(),
  session: string(),
  service: string(),
  first_seen_at: int(),
  last_seen_at: int(),
  item_count: int(),
  issue_count: int(),
});

const envelopeMetaRowSchema = object({
  id: string(),
  project: string(),
  session: string(),
  service: string(),
  received_at: int(),
  header: jsonColumn(jsonRecordSchema),
  size: int(),
  content_encoding: nullableString,
  item_count: int(),
  parse_error: nullableString,
  parse_warnings: jsonColumn(array(string())),
});

const envelopeRowSchema = envelopeMetaRowSchema.extend({
  body: nullable(instanceOf(Uint8Array)),
});

const issueRowSchema = object({
  id: string(),
  project: string(),
  session: string(),
  kind: literal(["error", "message"]),
  fingerprint: jsonColumn(array(string())),
  fingerprint_hash: string(),
  title: string(),
  culprit: nullableString,
  level: levelSchema,
  platform: nullableString,
  count: int(),
  first_seen_at: int(),
  last_seen_at: int(),
  last_item_id: string(),
});

const itemSummaryRowSchema = object({
  id: string(),
  envelope_id: string(),
  project: string(),
  session: string(),
  service: string(),
  kind: literal(ITEM_KINDS),
  item_type: string(),
  received_at: int(),
  timestamp: int(),
  event_id: nullableString,
  issue_id: nullableString,
  trace_id: nullableString,
  level: nullable(levelSchema),
  environment: nullableString,
  release: nullableString,
  platform: nullableString,
  title: string(),
});

const itemRowSchema = discriminatedUnion("kind", [
  itemSummaryRowSchema.extend({ kind: literal("error"), data: jsonColumn(eventDataSchema) }),
  itemSummaryRowSchema.extend({ kind: literal("message"), data: jsonColumn(eventDataSchema) }),
  itemSummaryRowSchema.extend({
    kind: literal("transaction"),
    data: jsonColumn(transactionDataSchema),
  }),
  itemSummaryRowSchema.extend({ kind: literal("span"), data: jsonColumn(spanDataSchema) }),
  itemSummaryRowSchema.extend({ kind: literal("log"), data: jsonColumn(logDataSchema) }),
  itemSummaryRowSchema.extend({
    kind: literal("attachment"),
    data: jsonColumn(attachmentDataSchema),
  }),
  itemSummaryRowSchema.extend({ kind: literal("other"), data: jsonColumn(otherDataSchema) }),
]);

const blobRowSchema = object({ data: instanceOf(Uint8Array) });

const ITEM_COLUMNS = [
  "id",
  "envelope_id",
  "project",
  "session",
  "service",
  "kind",
  "item_type",
  "received_at",
  "timestamp",
  "event_id",
  "issue_id",
  "trace_id",
  "level",
  "level_rank",
  "environment",
  "release",
  "platform",
  "title",
  "data",
] as const;

const ENVELOPE_COLUMNS = [
  "id",
  "project",
  "session",
  "service",
  "received_at",
  "header",
  "size",
  "content_encoding",
  "item_count",
  "parse_error",
  "parse_warnings",
  "body",
] as const;

type ItemRowParams = Record<(typeof ITEM_COLUMNS)[number], SqliteParam>;
type EnvelopeRowParams = Record<(typeof ENVELOPE_COLUMNS)[number], SqliteParam>;

/** `0` trace … `5` fatal; `null` without level. */
function levelRank(level: Level | null): number | null {
  return level === null ? null : LEVELS.indexOf(level);
}

function itemToRow(item: Item): ItemRowParams {
  return {
    id: item.id,
    envelope_id: item.envelopeId,
    project: item.scope.project,
    session: item.scope.session,
    service: item.scope.service,
    kind: item.kind,
    item_type: item.itemType,
    received_at: toMs(item.receivedAt),
    timestamp: toMs(item.timestamp),
    event_id: item.eventId,
    issue_id: item.issueId,
    trace_id: item.traceId,
    level: item.level,
    level_rank: levelRank(item.level),
    environment: item.environment,
    release: item.release,
    platform: item.platform,
    title: item.title,
    data: JSON.stringify(item.data),
  };
}

function summaryFromRow(row: output<typeof itemSummaryRowSchema>): ItemSummary {
  return {
    id: row.id,
    envelopeId: row.envelope_id,
    scope: { project: row.project, session: row.session, service: row.service },
    kind: row.kind,
    itemType: row.item_type,
    receivedAt: toIso(row.received_at),
    timestamp: toIso(row.timestamp),
    eventId: row.event_id,
    issueId: row.issue_id,
    traceId: row.trace_id,
    level: row.level,
    environment: row.environment,
    release: row.release,
    platform: row.platform,
    title: row.title,
  };
}

function rowToItemSummary(row: unknown): ItemSummary {
  return summaryFromRow(itemSummaryRowSchema.parse(row));
}

function rowToItem(row: unknown): Item {
  const parsed = itemRowSchema.parse(row);
  const summary = summaryFromRow(parsed);
  switch (parsed.kind) {
    case "error": {
      return { ...summary, kind: parsed.kind, data: parsed.data };
    }
    case "message": {
      return { ...summary, kind: parsed.kind, data: parsed.data };
    }
    case "transaction": {
      return { ...summary, kind: parsed.kind, data: parsed.data };
    }
    case "span": {
      return { ...summary, kind: parsed.kind, data: parsed.data };
    }
    case "log": {
      return { ...summary, kind: parsed.kind, data: parsed.data };
    }
    case "attachment": {
      return { ...summary, kind: parsed.kind, data: parsed.data };
    }
    case "other": {
      return { ...summary, kind: parsed.kind, data: parsed.data };
    }
    default: {
      return parsed satisfies never;
    }
  }
}

function rowToIssue(row: unknown, services: string[]): Issue {
  const parsed = issueRowSchema.parse(row);
  return {
    id: parsed.id,
    shortId: parsed.id.slice(0, SHORT_ID_LENGTH),
    project: parsed.project,
    session: parsed.session,
    fingerprint: parsed.fingerprint,
    fingerprintHash: parsed.fingerprint_hash,
    kind: parsed.kind,
    title: parsed.title,
    culprit: parsed.culprit,
    level: parsed.level,
    platform: parsed.platform,
    count: parsed.count,
    firstSeenAt: toIso(parsed.first_seen_at),
    lastSeenAt: toIso(parsed.last_seen_at),
    lastItemId: parsed.last_item_id,
    services: [...services],
  };
}

function envelopeToRow(envelope: Envelope): EnvelopeRowParams {
  return {
    id: envelope.id,
    project: envelope.scope.project,
    session: envelope.scope.session,
    service: envelope.scope.service,
    received_at: toMs(envelope.receivedAt),
    header: JSON.stringify(envelope.header),
    size: envelope.size,
    content_encoding: envelope.contentEncoding,
    item_count: envelope.itemCount,
    parse_error: envelope.parseError,
    parse_warnings: JSON.stringify(envelope.parseWarnings),
    body: envelope.body ?? null,
  };
}

/** Accepts rows with or without the `body` column. */
function rowToEnvelope(row: unknown): Envelope {
  const meta = envelopeMetaRowSchema.parse(row);
  const envelope: Envelope = {
    id: meta.id,
    scope: { project: meta.project, session: meta.session, service: meta.service },
    receivedAt: toIso(meta.received_at),
    header: meta.header,
    size: meta.size,
    contentEncoding: meta.content_encoding,
    itemCount: meta.item_count,
    parseError: meta.parse_error,
    parseWarnings: meta.parse_warnings,
  };
  const withBody = envelopeRowSchema.pick({ body: true }).safeParse(row);
  return withBody.success && withBody.data.body !== null
    ? { ...envelope, body: withBody.data.body }
    : envelope;
}

function rowToScopeSummary(row: unknown): ScopeSummary {
  const parsed = scopeRowSchema.parse(row);
  return {
    project: parsed.project,
    session: parsed.session,
    service: parsed.service,
    firstSeenAt: toIso(parsed.first_seen_at),
    lastSeenAt: toIso(parsed.last_seen_at),
    itemCount: parsed.item_count,
    issueCount: parsed.issue_count,
  };
}

export {
  blobRowSchema,
  ENVELOPE_COLUMNS,
  envelopeMetaRowSchema,
  envelopeRowSchema,
  envelopeToRow,
  ITEM_COLUMNS,
  issueRowSchema,
  itemRowSchema,
  itemSummaryRowSchema,
  itemToRow,
  levelRank,
  rowToEnvelope,
  rowToIssue,
  rowToItem,
  rowToItemSummary,
  rowToScopeSummary,
  scopeRowSchema,
  toMs,
};
export type { EnvelopeRowParams, ItemRowParams };
