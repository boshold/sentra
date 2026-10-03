import { createLiveBus } from "#src/live/bus.js";
import type { Envelope, ItemSummary, LiveEvent, LogItem, SentraLogger } from "#src/types.js";

function logger(): SentraLogger & { errors: string[] } {
  const errors: string[] = [];
  return {
    errors,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (message) => {
      errors.push(message);
    },
  };
}

function logItem(overrides: Partial<ItemSummary> = {}): LogItem {
  return {
    id: "id-1",
    envelopeId: "env-1",
    scope: { project: "p", session: "s", service: "web" },
    itemType: "log",
    receivedAt: "2026-10-03T10:00:00.000Z",
    timestamp: "2026-10-03T10:00:00.000Z",
    eventId: null,
    issueId: null,
    traceId: null,
    level: "info",
    environment: null,
    release: null,
    platform: null,
    title: "hello",
    ...overrides,
    kind: "log",
    data: { body: "hello", severityNumber: null, spanId: null, attributes: {} },
  };
}

function created(overrides: Partial<ItemSummary> = {}): LiveEvent {
  return { type: "item.created", item: logItem(overrides), issue: null };
}

function failed(scope = { project: "p", session: "s", service: "web" }): LiveEvent {
  const envelope: Omit<Envelope, "body"> = {
    id: "env-2",
    scope,
    receivedAt: "2026-10-03T10:00:00.000Z",
    header: {},
    size: 1,
    contentEncoding: null,
    itemCount: 0,
    parseError: "bad",
    parseWarnings: [],
  };
  return { type: "envelope.failed", envelope, error: "bad" };
}

describe("createLiveBus", () => {
  it("delivers item.created to matching listeners only", () => {
    const bus = createLiveBus(logger());
    const all: LiveEvent[] = [];
    const warnings: LiveEvent[] = [];
    bus.subscribe({}, (event) => all.push(event));
    bus.subscribe({ minLevel: "warning" }, (event) => warnings.push(event));
    bus.publish(created({ level: "info" }));
    bus.publish(created({ level: "error", id: "id-2" }));
    expect(all).toHaveLength(2);
    expect(warnings).toHaveLength(1);
  });

  it("filters envelope.failed by scope only", () => {
    const bus = createLiveBus(logger());
    const received: LiveEvent[] = [];
    bus.subscribe({ project: ["p"], kind: ["error"], q: "nothing" }, (event) =>
      received.push(event),
    );
    bus.publish(failed());
    bus.publish(failed({ project: "other", session: "s", service: "web" }));
    expect(received).toHaveLength(1);
  });

  it("isolates and logs throwing listeners", () => {
    const log = logger();
    const bus = createLiveBus(log);
    const received: LiveEvent[] = [];
    bus.subscribe({}, () => {
      throw new Error("listener boom");
    });
    bus.subscribe({}, (event) => received.push(event));
    expect(() => {
      bus.publish(created());
    }).not.toThrow();
    expect(received).toHaveLength(1);
    expect(log.errors).toEqual(["live listener failed: listener boom"]);
  });

  it("unsubscribes idempotently and clears", () => {
    const bus = createLiveBus(logger());
    const received: LiveEvent[] = [];
    const unsubscribe = bus.subscribe({}, (event) => received.push(event));
    const other = bus.subscribe({}, (event) => received.push(event));
    unsubscribe();
    unsubscribe();
    bus.publish(created());
    expect(received).toHaveLength(1);
    bus.clear();
    bus.publish(created());
    expect(received).toHaveLength(1);
    other();
  });

  it("does not deliver to listeners removed during publish", () => {
    const bus = createLiveBus(logger());
    const received: string[] = [];
    let second: () => void = () => undefined;
    bus.subscribe({}, () => {
      received.push("first");
      second();
    });
    second = bus.subscribe({}, () => received.push("second"));
    bus.publish(created());
    expect(received).toEqual(["first"]);
  });
});
