import type {
  ErrorItem,
  EventData,
  Frame,
  Issue,
  ItemSummary,
  LogItem,
  MappedLocation,
  SpanItem,
  SpanSummary,
  TransactionItem,
} from "#src/types.js";

const NOW = new Date("2026-10-03T12:00:00.000Z");

function frame(overrides: Partial<Frame> = {}): Frame {
  return {
    filename: "app.js",
    absPath: null,
    function: "fn",
    module: null,
    lineno: 1,
    colno: 1,
    inApp: true,
    contextLine: null,
    preContext: [],
    postContext: [],
    positionReliable: true,
    mapped: null,
    ...overrides,
  };
}

function mapped(overrides: Partial<MappedLocation> = {}): MappedLocation {
  return {
    source: "components/User/Profile/Card.vue",
    absPath: null,
    lineno: 42,
    colno: 13,
    function: null,
    contextLine: null,
    preContext: [],
    postContext: [],
    ...overrides,
  };
}

function libraryFrame(overrides: Partial<Frame> = {}): Frame {
  return frame({
    filename: "node_modules/vue/index.js",
    function: "callWithErrorHandling",
    inApp: false,
    ...overrides,
  });
}

function summary(overrides: Partial<ItemSummary> = {}): ItemSummary {
  return {
    id: "01JITEM000000000000000000",
    envelopeId: "01JENV0000000000000000000",
    scope: { project: "my-app", session: "3f9a1c", service: "web" },
    kind: "error",
    itemType: "event",
    receivedAt: "2026-10-03T11:59:00.000Z",
    timestamp: "2026-10-03T11:59:00.000Z",
    eventId: null,
    issueId: null,
    traceId: null,
    level: null,
    environment: null,
    release: null,
    platform: null,
    title: "title",
    ...overrides,
  };
}

function eventData(overrides: Partial<EventData> = {}): EventData {
  return {
    message: null,
    exceptions: [],
    stacktrace: [],
    culprit: null,
    transaction: null,
    logger: null,
    dist: null,
    serverName: null,
    user: null,
    request: null,
    tags: {},
    contexts: {},
    extra: {},
    breadcrumbs: [],
    sdk: null,
    fingerprint: [],
    sourceMaps: { status: "not_applicable", mappedFrames: 0, candidateFrames: 0, errors: [] },
    ...overrides,
  };
}

function errorItem(data: Partial<EventData> = {}, overrides: Partial<ItemSummary> = {}): ErrorItem {
  return { ...summary(overrides), kind: "error", data: eventData(data) };
}

function spanSummary(durationMs: number, overrides: Partial<SpanSummary> = {}): SpanSummary {
  return {
    spanId: `span${durationMs}`,
    parentSpanId: null,
    op: "db",
    description: `query ${durationMs}`,
    status: "ok",
    startTimestamp: "2026-10-03T11:59:00.000Z",
    durationMs,
    ...overrides,
  };
}

function transactionItem(spans: SpanSummary[]): TransactionItem {
  return {
    ...summary({ kind: "transaction", itemType: "transaction", title: "GET /api/users" }),
    kind: "transaction",
    data: {
      name: "GET /api/users",
      op: "http.server",
      status: "ok",
      startTimestamp: "2026-10-03T11:59:00.000Z",
      durationMs: 142,
      spanId: "aaaa",
      parentSpanId: null,
      spans,
      measurements: {},
      tags: {},
      contexts: {},
      request: null,
      sdk: null,
    },
  };
}

function spanItem(durationMs: number, overrides: Partial<SpanItem["data"]> = {}): SpanItem {
  return {
    ...summary({ id: `01JSPAN${durationMs}`, kind: "span", itemType: "span", title: "span" }),
    kind: "span",
    data: {
      name: `span ${durationMs}`,
      spanId: `s${durationMs}`,
      parentSpanId: null,
      isSegment: false,
      status: "ok",
      startTimestamp: "2026-10-03T11:59:00.000Z",
      durationMs,
      op: "db",
      attributes: {},
      ...overrides,
    },
  };
}

function logItem(): LogItem {
  return {
    ...summary({ kind: "log", itemType: "log", level: "info", title: "user logged in" }),
    kind: "log",
    data: { body: "user logged in", severityNumber: 9, spanId: null, attributes: { userId: 12 } },
  };
}

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "7c2f91ab-0000-7000-8000-000000000000",
    shortId: "7c2f91ab",
    project: "my-app",
    session: "3f9a1c",
    fingerprint: ["x"],
    fingerprintHash: "hash",
    kind: "error",
    title: "TypeError: boom",
    culprit: null,
    level: "error",
    platform: "node",
    count: 3,
    firstSeenAt: "2026-10-01T12:00:00.000Z",
    lastSeenAt: "2026-10-03T11:55:00.000Z",
    lastItemId: "01JITEM000000000000000000",
    services: ["web", "api"],
    ...overrides,
  };
}

export {
  NOW,
  errorItem,
  eventData,
  frame,
  issue,
  libraryFrame,
  logItem,
  mapped,
  spanItem,
  spanSummary,
  summary,
  transactionItem,
};
