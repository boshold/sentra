import { record, string, unknown } from "zod";
import type { infer as Infer } from "zod";

import { normalizeFrames } from "#src/normalize/frames.js";
import type { FrameOptions } from "#src/normalize/frames.js";
import { normalizeLevel } from "#src/normalize/level.js";
import {
  collectDropped,
  contextsSchema,
  eventPayloadSchema,
  normalizeEventId,
  truncate,
} from "#src/normalize/schemas.js";
import { toIsoTimestamp } from "#src/normalize/time.js";
import type { GroupingInput, NewItem, NormalizeContext } from "#src/normalize/types.js";
import type { EventData, Exception, Frame, Item, ItemSummary } from "#src/types.js";

type EventPayload = Infer<typeof eventPayloadSchema>;
type ExceptionValue = NonNullable<NonNullable<EventPayload["exception"]>["values"]>[number];

type EventKind = "error" | "message";

type NormalizeEventResult = { ok: true; items: NewItem[] } | { ok: false; error: string };

const TITLE_MAX = 500;
const UNKNOWN_TITLE = "<unknown error>";

const EVENT_KEYS = [
  "event_id",
  "timestamp",
  "level",
  "platform",
  "environment",
  "release",
  "dist",
  "logger",
  "server_name",
  "transaction",
  "culprit",
  "message",
  "logentry",
  "exception",
  "stacktrace",
  "threads",
  "fingerprint",
  "user",
  "request",
  "tags",
  "contexts",
  "extra",
  "breadcrumbs",
  "sdk",
] as const;

const payloadObjectSchema = record(string(), unknown());

function nonEmpty(value: string | undefined): string | null {
  return value === undefined || value === "" ? null : value;
}

function hasType(value: ExceptionValue): boolean {
  return nonEmpty(value.type) !== null;
}

function resolveMessage(payload: EventPayload): string | null {
  const { logentry, message } = payload;
  const fromMessage =
    typeof message === "object" ? (message.formatted ?? message.message) : message;
  return logentry?.formatted ?? logentry?.message ?? fromMessage ?? null;
}

function resolveMessageTemplate(payload: EventPayload): string | null {
  const { logentry, message } = payload;
  const fromMessage = typeof message === "object" ? message.message : message;
  return logentry?.message ?? fromMessage ?? null;
}

function toException(value: ExceptionValue, frameOptions: FrameOptions): Exception {
  const mechanismType = value.mechanism?.type;
  return {
    type: value.type ?? null,
    value: value.value ?? null,
    module: value.module ?? null,
    mechanism:
      mechanismType === undefined
        ? null
        : { type: mechanismType, handled: value.mechanism?.handled ?? null },
    frames: normalizeFrames(value.stacktrace?.frames, frameOptions),
  };
}

function messageStacktrace(
  payload: EventPayload,
  values: ExceptionValue[],
  frameOptions: FrameOptions,
): Frame[] {
  const synthetic = values.findLast((value) => value.stacktrace?.frames !== undefined);
  const thread = payload.threads?.values?.find((entry) => entry.stacktrace?.frames !== undefined);
  const frames =
    synthetic?.stacktrace?.frames ?? payload.stacktrace?.frames ?? thread?.stacktrace?.frames;
  return normalizeFrames(frames, frameOptions);
}

function errorTitle(primary: Exception | undefined): string {
  const type = nonEmpty(primary?.type ?? undefined);
  const value = nonEmpty(primary?.value ?? undefined);
  if (type !== null && value !== null) {
    return `${type}: ${value}`;
  }
  return type ?? value ?? UNKNOWN_TITLE;
}

function resolveGrouping(payload: EventPayload): GroupingInput {
  const { fingerprint } = payload;
  return {
    payloadFingerprint: fingerprint !== undefined && fingerprint.length > 0 ? fingerprint : null,
    messageTemplate: resolveMessageTemplate(payload),
  };
}

function classify(payload: EventPayload, values: ExceptionValue[]): EventKind {
  const hasMessage = payload.message !== undefined || payload.logentry !== undefined;
  if (hasMessage && !values.some((value) => hasType(value))) {
    return "message";
  }
  return values.length > 0 ? "error" : "message";
}

function resolveTraceId(contexts: Record<string, unknown>): string | null {
  const parsed = contextsSchema.safeParse(contexts);
  return (parsed.success ? parsed.data.trace?.trace_id : undefined) ?? null;
}

function buildData(payload: EventPayload, kind: EventKind, frameOptions: FrameOptions): EventData {
  const values = payload.exception?.values ?? [];
  return {
    message: resolveMessage(payload),
    exceptions: kind === "error" ? values.map((value) => toException(value, frameOptions)) : [],
    stacktrace: kind === "message" ? messageStacktrace(payload, values, frameOptions) : [],
    culprit: payload.culprit ?? null,
    transaction: payload.transaction ?? null,
    logger: payload.logger ?? null,
    dist: payload.dist ?? null,
    serverName: payload.server_name ?? null,
    user: payload.user ?? null,
    request: payload.request ?? null,
    tags: payload.tags ?? {},
    contexts: payload.contexts ?? {},
    extra: payload.extra ?? {},
    breadcrumbs: payload.breadcrumbs ?? [],
    sdk: payload.sdk ?? null,
    fingerprint: [],
    sourceMaps: { status: "not_applicable", mappedFrames: 0, candidateFrames: 0, errors: [] },
  };
}

function resolveTitle(kind: EventKind, data: EventData): string {
  const title =
    kind === "error"
      ? errorTitle(data.exceptions.at(-1))
      : (nonEmpty(data.message ?? undefined) ?? UNKNOWN_TITLE);
  return truncate(title, TITLE_MAX);
}

function buildSummary(
  payload: EventPayload,
  kind: EventKind,
  data: EventData,
  ctx: NormalizeContext,
): Omit<ItemSummary, "kind"> {
  return {
    id: ctx.newId(),
    envelopeId: ctx.envelopeId,
    scope: ctx.scope,
    itemType: "event",
    receivedAt: ctx.receivedAt,
    timestamp: toIsoTimestamp(payload.timestamp, ctx.receivedAt),
    eventId: normalizeEventId(payload.event_id),
    issueId: null,
    traceId: resolveTraceId(data.contexts),
    level: normalizeLevel(payload.level) ?? (kind === "error" ? "error" : "info"),
    environment: payload.environment ?? null,
    release: payload.release ?? null,
    platform: payload.platform ?? null,
    title: resolveTitle(kind, data),
  };
}

function normalizeEvent(payload: unknown, ctx: NormalizeContext): NormalizeEventResult {
  const input = payloadObjectSchema.safeParse(payload);
  const parsed = eventPayloadSchema.safeParse(payload);
  if (!input.success || !parsed.success) {
    return { ok: false, error: "event payload is not a JSON object" };
  }
  const event = parsed.data;
  const kind = classify(event, event.exception?.values ?? []);
  const frameOptions: FrameOptions = {
    platform: event.platform ?? null,
    allowedHosts: ctx.allowedHosts,
  };
  const data = buildData(event, kind, frameOptions);
  const summary = buildSummary(event, kind, data, ctx);
  const warnings = collectDropped(input.data, event, EVENT_KEYS).map(
    (key) => `event: dropped invalid field '${key}'`,
  );
  const item: Item = kind === "error" ? { ...summary, kind, data } : { ...summary, kind, data };
  return {
    ok: true,
    items: [{ item, blob: null, grouping: resolveGrouping(event), warnings }],
  };
}

export { normalizeEvent };
export type { NormalizeEventResult };
