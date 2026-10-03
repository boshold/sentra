import type { infer as Infer } from "zod";

import {
  collectDropped,
  contextsSchema,
  jsonObjectSchema,
  normalizeEventId,
  transactionPayloadSchema,
  truncate,
} from "#src/normalize/schemas.js";
import { ITEM_TITLE_MAX, baseSummary } from "#src/normalize/summary.js";
import { durationMs, parseTimestampMs, toIso, toIsoTimestamp } from "#src/normalize/time.js";
import type { NormalizeContext, NormalizeResult } from "#src/normalize/types.js";
import type { SpanSummary, TransactionData } from "#src/types.js";

type TransactionPayload = Infer<typeof transactionPayloadSchema>;
type TransactionSpan = NonNullable<TransactionPayload["spans"]>[number];
type TraceContext = NonNullable<Infer<typeof contextsSchema>["trace"]>;

const UNNAMED = "<unnamed transaction>";

const TRANSACTION_KEYS = [
  "event_id",
  "timestamp",
  "start_timestamp",
  "platform",
  "environment",
  "release",
  "transaction",
  "spans",
  "measurements",
  "request",
  "tags",
  "contexts",
  "sdk",
] as const;

function toSpanSummary(span: TransactionSpan, fallbackStart: string): SpanSummary[] {
  if (span.span_id === undefined) {
    return [];
  }
  const startMs = parseTimestampMs(span.start_timestamp);
  return [
    {
      spanId: span.span_id,
      parentSpanId: span.parent_span_id ?? null,
      op: span.op ?? null,
      description: span.description ?? null,
      status: span.status ?? null,
      startTimestamp: startMs === null ? fallbackStart : toIso(startMs),
      durationMs: durationMs(span.start_timestamp, span.timestamp),
    },
  ];
}

function toMeasurements(
  measurements: TransactionPayload["measurements"],
): TransactionData["measurements"] {
  const result: TransactionData["measurements"] = {};
  for (const [name, measurement] of Object.entries(measurements ?? {})) {
    if (measurement.value !== undefined) {
      result[name] = { value: measurement.value, unit: measurement.unit ?? null };
    }
  }
  return result;
}

function resolveTrace(contexts: Record<string, unknown>): TraceContext | undefined {
  const parsed = contextsSchema.safeParse(contexts);
  return parsed.success ? parsed.data.trace : undefined;
}

function buildData(
  transaction: TransactionPayload,
  trace: TraceContext | undefined,
  timestamp: string,
): TransactionData {
  const startTimestamp = toIsoTimestamp(transaction.start_timestamp, timestamp);
  return {
    name: transaction.transaction ?? UNNAMED,
    op: trace?.op ?? null,
    status: trace?.status ?? null,
    startTimestamp,
    durationMs: durationMs(transaction.start_timestamp, transaction.timestamp),
    spanId: trace?.span_id ?? null,
    parentSpanId: trace?.parent_span_id ?? null,
    spans: (transaction.spans ?? []).flatMap((span) => toSpanSummary(span, startTimestamp)),
    measurements: toMeasurements(transaction.measurements),
    tags: transaction.tags ?? {},
    contexts: transaction.contexts ?? {},
    request: transaction.request ?? null,
    sdk: transaction.sdk ?? null,
  };
}

function normalizeTransaction(payload: unknown, ctx: NormalizeContext): NormalizeResult {
  const input = jsonObjectSchema.safeParse(payload);
  const parsed = transactionPayloadSchema.safeParse(payload);
  if (!input.success || !parsed.success) {
    return { ok: false, error: "transaction payload is not a JSON object" };
  }
  const transaction = parsed.data;
  const trace = resolveTrace(transaction.contexts ?? {});
  const timestamp = toIsoTimestamp(transaction.timestamp, ctx.receivedAt);
  const data = buildData(transaction, trace, timestamp);
  const summary = baseSummary(ctx, {
    itemType: "transaction",
    timestamp,
    eventId: normalizeEventId(transaction.event_id),
    traceId: trace?.trace_id ?? null,
    environment: transaction.environment ?? null,
    release: transaction.release ?? null,
    platform: transaction.platform ?? null,
    title: truncate(data.name, ITEM_TITLE_MAX),
  });
  const warnings = collectDropped(input.data, transaction, TRANSACTION_KEYS).map(
    (key) => `transaction: dropped invalid field '${key}'`,
  );
  return {
    ok: true,
    items: [
      { item: { ...summary, kind: "transaction", data }, blob: null, grouping: null, warnings },
    ],
  };
}

export { normalizeTransaction };
