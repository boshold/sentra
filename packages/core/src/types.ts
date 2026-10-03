// Public data model (40_data_model.md) and filter types (50_api.md).

import type { ZodObject } from "zod";

export interface Scope {
  project: string;
  session: string;
  service: string;
}

export interface ScopeRow extends Scope {
  firstSeenAt: string;
  lastSeenAt: string;
  itemCount: number;
}

export interface ScopeSummary extends ScopeRow {
  issueCount: number;
}

export interface Envelope {
  id: string;
  scope: Scope;
  receivedAt: string;
  header: Record<string, unknown>;
  size: number;
  contentEncoding: string | null;
  itemCount: number;
  parseError: string | null;
  parseWarnings: string[];
  body?: Uint8Array;
}

export const LEVELS = ["trace", "debug", "info", "warning", "error", "fatal"] as const;
export type Level = (typeof LEVELS)[number];

export const ITEM_KINDS = [
  "error",
  "message",
  "transaction",
  "span",
  "log",
  "attachment",
  "other",
] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export interface ItemSummary {
  id: string;
  envelopeId: string;
  scope: Scope;
  kind: ItemKind;
  itemType: string;
  receivedAt: string;
  timestamp: string;
  eventId: string | null;
  issueId: string | null;
  traceId: string | null;
  level: Level | null;
  environment: string | null;
  release: string | null;
  platform: string | null;
  title: string;
}

export interface MappedLocation {
  source: string;
  absPath: string | null;
  lineno: number;
  colno: number | null;
  function: string | null;
  contextLine: string | null;
  preContext: string[];
  postContext: string[];
}

export interface Frame {
  filename: string | null;
  absPath: string | null;
  function: string | null;
  module: string | null;
  lineno: number | null;
  colno: number | null;
  inApp: boolean;
  contextLine: string | null;
  preContext: string[];
  postContext: string[];
  positionReliable: boolean;
  mapped: MappedLocation | null;
}

export interface SourceMapInfo {
  status: "not_applicable" | "none" | "partial" | "full";
  mappedFrames: number;
  candidateFrames: number;
  errors: { absPath: string; reason: string }[];
}

export interface Exception {
  type: string | null;
  value: string | null;
  module: string | null;
  mechanism: { type: string; handled: boolean | null } | null;
  frames: Frame[];
}

export interface Breadcrumb {
  timestamp: string | null;
  type: string | null;
  category: string | null;
  level: Level | null;
  message: string | null;
  data: Record<string, unknown> | null;
}

export interface RequestInfo {
  method: string | null;
  url: string | null;
  headers: Record<string, string>;
  query: string | null;
  data: unknown;
}

export interface EventData {
  message: string | null;
  exceptions: Exception[];
  stacktrace: Frame[];
  culprit: string | null;
  transaction: string | null;
  logger: string | null;
  dist: string | null;
  serverName: string | null;
  user: Record<string, unknown> | null;
  request: RequestInfo | null;
  tags: Record<string, string>;
  contexts: Record<string, unknown>;
  extra: Record<string, unknown>;
  breadcrumbs: Breadcrumb[];
  sdk: { name: string; version: string } | null;
  fingerprint: string[];
  sourceMaps: SourceMapInfo;
}

export interface SpanSummary {
  spanId: string;
  parentSpanId: string | null;
  op: string | null;
  description: string | null;
  status: string | null;
  startTimestamp: string;
  durationMs: number;
}

export interface TransactionData {
  name: string;
  op: string | null;
  status: string | null;
  startTimestamp: string;
  durationMs: number;
  spanId: string | null;
  parentSpanId: string | null;
  spans: SpanSummary[];
  measurements: Record<string, { value: number; unit: string | null }>;
  tags: Record<string, string>;
  contexts: Record<string, unknown>;
  request: RequestInfo | null;
  sdk: { name: string; version: string } | null;
}

export interface SpanData {
  name: string;
  spanId: string;
  parentSpanId: string | null;
  isSegment: boolean;
  status: string | null;
  startTimestamp: string;
  durationMs: number;
  op: string | null;
  attributes: Record<string, string | number | boolean>;
}

export interface LogData {
  body: string;
  severityNumber: number | null;
  spanId: string | null;
  attributes: Record<string, string | number | boolean>;
}

export interface AttachmentData {
  filename: string;
  contentType: string | null;
  attachmentType: string | null;
  size: number;
  stored: boolean;
}

export interface OtherData {
  payloadEncoding: "json" | "text" | "binary";
  payload: unknown;
  size: number;
  normalizeError: string | null;
}

export type ErrorItem = ItemSummary & { kind: "error"; data: EventData };
export type MessageItem = ItemSummary & { kind: "message"; data: EventData };
export type TransactionItem = ItemSummary & { kind: "transaction"; data: TransactionData };
export type SpanItem = ItemSummary & { kind: "span"; data: SpanData };
export type LogItem = ItemSummary & { kind: "log"; data: LogData };
export type AttachmentItem = ItemSummary & { kind: "attachment"; data: AttachmentData };
export type OtherItem = ItemSummary & { kind: "other"; data: OtherData };

export type Item =
  | ErrorItem
  | MessageItem
  | TransactionItem
  | SpanItem
  | LogItem
  | AttachmentItem
  | OtherItem;

export interface Issue {
  id: string;
  shortId: string;
  project: string;
  session: string;
  fingerprint: string[];
  fingerprintHash: string;
  kind: "error" | "message";
  title: string;
  culprit: string | null;
  level: Level;
  platform: string | null;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastItemId: string;
  services: string[];
}

export interface IssueDetail extends Issue {
  latest: Item | null;
}

// Kept verbatim from 40_data_model.md.
// prettier-ignore
export type LiveEvent =
  | { type: "item.created"; item: Item; issue: { id: string; isNew: boolean; count: number } | null }
  | { type: "envelope.failed"; envelope: Omit<Envelope, "body">; error: string };

export type Duration = `${number}${"ms" | "s" | "m" | "h" | "d" | "w"}`;
export type OneOrMany<T> = T | T[];

export interface ScopeFilter {
  project?: OneOrMany<string>;
  session?: OneOrMany<string>;
  service?: OneOrMany<string>;
}

/** `since` XOR `from`. */
export interface TimeFilter {
  since?: Duration;
  from?: string | number;
  to?: string | number;
}

export interface ItemFilter extends ScopeFilter, TimeFilter {
  kind?: OneOrMany<ItemKind>;
  itemType?: OneOrMany<string>;
  level?: OneOrMany<Level>;
  minLevel?: Level;
  environment?: OneOrMany<string>;
  release?: OneOrMany<string>;
  eventId?: string;
  issueId?: string;
  traceId?: string;
  /** Case-insensitive substring on title. */
  q?: string;
}

/** Time filter applies to `lastSeenAt`. */
export interface IssueFilter extends ScopeFilter, TimeFilter {
  kind?: OneOrMany<"error" | "message">;
  level?: OneOrMany<Level>;
  minLevel?: Level;
  q?: string;
}

export type LiveFilter = Omit<ItemFilter, "since" | "from" | "to">;

export interface PageInput {
  limit?: number;
  cursor?: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface SentraLogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface SentraToolDefinition {
  name: string;
  title: string;
  description: string;
  /** Full zod v4 object schema. */
  inputSchema: ZodObject;
  annotations: { readOnlyHint: boolean };
  handler(
    input: unknown,
  ): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;
}
