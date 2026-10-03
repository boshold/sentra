import { createSentra, memoryStorage } from "@bosdev/sentra-core";
import type { EventData, Frame, Item, ItemSummary, LiveEvent } from "@bosdev/sentra-core";

import { fixtureToRequest, loadEnvelopeFixture } from "../../../../test/fixtures/envelopes.js";

/** Live events produced by ingesting the named fixtures. */
async function fixtureEvents(names: string[], path?: string): Promise<LiveEvent[]> {
  const sentra = await createSentra({ storage: memoryStorage() });
  const events: LiveEvent[] = [];
  const unsubscribe = sentra.subscribe({}, (event) => {
    events.push(event);
  });
  try {
    for (const name of names) {
      const request = fixtureToRequest(loadEnvelopeFixture(name));
      await sentra.handle(
        path === undefined
          ? request
          : new Request(new URL(path, request.url), {
              method: "POST",
              headers: request.headers,
              body: await request.arrayBuffer(),
            }),
      );
    }
  } finally {
    unsubscribe();
    await sentra.close();
  }
  return events;
}

const RECEIVED_AT = "2026-10-03T14:03:21.000Z";

function summary(overrides: Partial<ItemSummary> = {}): ItemSummary {
  return {
    id: "01a10205-0000-7000-8000-000000000001",
    envelopeId: "01a10205-0000-7000-8000-000000000000",
    scope: { project: "my-app", session: "3f9a1c", service: "api" },
    kind: "log",
    itemType: "log",
    receivedAt: RECEIVED_AT,
    timestamp: RECEIVED_AT,
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

function created(
  item: Item,
  issue: { id: string; isNew: boolean; count: number } | null = null,
): LiveEvent {
  return { type: "item.created", item, issue };
}

function logItem(
  attributes: Record<string, string | number | boolean>,
  level: Item["level"] = "info",
): Item {
  return {
    ...summary({ kind: "log", itemType: "log", level, title: "user logged in" }),
    kind: "log",
    data: { body: "user logged in", severityNumber: 9, spanId: null, attributes },
  };
}

function spanItem(isSegment: boolean): Item {
  return {
    ...summary({ kind: "span", itemType: "span", title: "GET /api/users" }),
    kind: "span",
    data: {
      name: "GET /api/users",
      spanId: "aaaa",
      parentSpanId: isSegment ? null : "bbbb",
      isSegment,
      status: "ok",
      startTimestamp: RECEIVED_AT,
      durationMs: 142,
      op: "http.server",
      attributes: {},
    },
  };
}

function otherItem(itemType: string, size: number): Item {
  return {
    ...summary({ kind: "other", itemType, title: itemType }),
    kind: "other",
    data: { payloadEncoding: "json", payload: {}, size, normalizeError: null },
  };
}

export {
  RECEIVED_AT,
  created,
  eventData,
  fixtureEvents,
  frame,
  logItem,
  otherItem,
  spanItem,
  summary,
};
