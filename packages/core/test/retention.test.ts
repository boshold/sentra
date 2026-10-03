import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createRetention } from "#src/retention.js";
import { createSentra } from "#src/sentra.js";
import { memoryStorage } from "#src/storage/memory/index.js";
import type { StorageAdapter } from "#src/storage/types.js";
import type { ItemKind, SentraLogger } from "#src/types.js";

import { makeBatch } from "../../../test/storage-contract.js";

import { storageWith } from "./helpers/storage.js";

const NOW = Date.parse("2026-10-03T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface Calls {
  idle: Date[];
  old: { kinds: ItemKind[]; cutoff: Date }[];
}

function spyStorage(calls: Calls, fail: () => boolean = () => false): StorageAdapter {
  const inner = memoryStorage();
  return {
    ...storageWith({}, inner),
    pruneIdleSessions: async (cutoff) => {
      calls.idle.push(cutoff);
      if (fail()) {
        throw new Error("prune boom");
      }
      return Promise.resolve({ sessionsDeleted: 2, itemsDeleted: 5 });
    },
    pruneOldItems: async (kinds, cutoff) => {
      calls.old.push({ kinds, cutoff });
      return Promise.resolve({ itemsDeleted: 7 });
    },
  };
}

function recordingLogger(): SentraLogger & { debugs: string[]; errors: string[] } {
  const debugs: string[] = [];
  const errors: string[] = [];
  return {
    debugs,
    errors,
    debug: (message) => {
      debugs.push(message);
    },
    info: () => undefined,
    warn: () => undefined,
    error: (message) => {
      errors.push(message);
    },
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

describe("createRetention", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs both rules with cutoffs from now and sums the result", async () => {
    const calls: Calls = { idle: [], old: [] };
    const logger = recordingLogger();
    const retention = createRetention({
      storage: spyStorage(calls),
      maxIdleMs: 30 * DAY,
      noiseMaxAgeMs: 7 * DAY,
      logger,
      now: () => NOW,
    });
    expect(await retention.prune()).toEqual({ sessionsDeleted: 2, itemsDeleted: 12 });
    expect(calls.idle).toEqual([new Date(NOW - 30 * DAY)]);
    expect(calls.old).toEqual([
      { kinds: ["span", "transaction", "log", "other"], cutoff: new Date(NOW - 7 * DAY) },
    ]);
    expect(logger.debugs).toEqual(["retention: 2 sessions, 12 records deleted"]);
  });

  it.each([
    [null, 7 * DAY, { sessionsDeleted: 0, itemsDeleted: 7 }, 0, 1],
    [30 * DAY, null, { sessionsDeleted: 2, itemsDeleted: 5 }, 1, 0],
    [null, null, { sessionsDeleted: 0, itemsDeleted: 0 }, 0, 0],
  ])(
    "skips disabled rules (maxIdle %s, noise %s)",
    async (maxIdleMs, noiseMaxAgeMs, expected, idleCalls, oldCalls) => {
      const calls: Calls = { idle: [], old: [] };
      const retention = createRetention({
        storage: spyStorage(calls),
        maxIdleMs,
        noiseMaxAgeMs,
        logger: recordingLogger(),
        now: () => NOW,
      });
      expect(await retention.prune()).toEqual(expected);
      expect(calls.idle).toHaveLength(idleCalls);
      expect(calls.old).toHaveLength(oldCalls);
    },
  );

  it("prunes hourly once started, logs failed ticks and stops", async () => {
    vi.useFakeTimers();
    const calls: Calls = { idle: [], old: [] };
    let failNext = false;
    const logger = recordingLogger();
    const retention = createRetention({
      storage: spyStorage(calls, () => failNext),
      maxIdleMs: DAY,
      noiseMaxAgeMs: DAY,
      logger,
    });
    retention.start();
    retention.start();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(calls.idle).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3 * HOUR);
    expect(calls.idle).toHaveLength(4);

    failNext = true;
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(logger.errors).toEqual(["retention failed: prune boom"]);
    failNext = false;
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(calls.idle).toHaveLength(6);
    expect(calls.old).toHaveLength(5);

    retention.stop();
    retention.stop();
    await vi.advanceTimersByTimeAsync(5 * HOUR);
    expect(calls.idle).toHaveLength(6);
  });

  it("unrefs its timer and creates none when both rules are disabled", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const enabled = createRetention({
      storage: memoryStorage(),
      maxIdleMs: DAY,
      noiseMaxAgeMs: null,
      logger: recordingLogger(),
    });
    enabled.start();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    const timer = setIntervalSpy.mock.results[0]?.value;
    expect(timer).toHaveProperty("hasRef");
    expect(
      typeof timer === "object" &&
        timer !== null &&
        "hasRef" in timer &&
        typeof timer.hasRef === "function" &&
        timer.hasRef(),
    ).toBe(false);
    enabled.stop();

    const disabled = createRetention({
      storage: memoryStorage(),
      maxIdleMs: null,
      noiseMaxAgeMs: null,
      logger: recordingLogger(),
    });
    disabled.start();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });
});

describe("retention in createSentra", () => {
  async function prefilled(): Promise<{ storage: StorageAdapter; ids: Record<string, string> }> {
    const storage = memoryStorage();
    await storage.init();
    const now = Date.now();
    const idle = makeBatch({
      scope: { project: "app", session: "idle" },
      receivedAt: iso(now - 31 * DAY),
      items: [{}],
    });
    const old = makeBatch({
      scope: { project: "app", session: "active" },
      receivedAt: iso(now - 10 * DAY),
      items: [
        { kind: "log", itemType: "log" },
        { kind: "span", itemType: "span" },
        { kind: "error", issueId: "00000000000000e1" },
        { kind: "attachment", itemType: "attachment", blob: new Uint8Array([1]) },
      ],
    });
    const fresh = makeBatch({
      scope: { project: "app", session: "active" },
      receivedAt: iso(now - HOUR),
      items: [{ kind: "log", itemType: "log" }],
    });
    for (const batch of [idle, old, fresh]) {
      await storage.write(batch);
    }
    const id = (batch: typeof old, index: number): string => batch.items[index]?.item.id ?? "";
    return {
      storage,
      ids: {
        idle: id(idle, 0),
        log: id(old, 0),
        span: id(old, 1),
        error: id(old, 2),
        attachment: id(old, 3),
        fresh: id(fresh, 0),
      },
    };
  }

  it("runs a first pass on creation", async () => {
    const { storage, ids } = await prefilled();
    const sentra = await createSentra({
      storage,
      retention: { maxIdle: "30d", noiseMaxAge: "7d" },
    });
    expect(await sentra.query.getItem(ids.idle ?? "")).toBeNull();
    expect(await sentra.query.listScopes({ session: "idle" })).toEqual([]);
    expect(await sentra.query.getItem(ids.log ?? "")).toBeNull();
    expect(await sentra.query.getItem(ids.span ?? "")).toBeNull();
    expect(await sentra.query.getItem(ids.error ?? "")).not.toBeNull();
    expect(await sentra.query.getItem(ids.attachment ?? "")).not.toBeNull();
    expect(await sentra.query.getItem(ids.fresh ?? "")).not.toBeNull();
    expect(await sentra.query.getIssue("00000000000000e1")).not.toBeNull();
    expect(await sentra.prune()).toEqual({ sessionsDeleted: 0, itemsDeleted: 0 });
    await sentra.close();
  });

  it("deletes nothing with both rules disabled", async () => {
    const { storage, ids } = await prefilled();
    const sentra = await createSentra({
      storage,
      retention: { maxIdle: "never", noiseMaxAge: "never" },
    });
    for (const id of Object.values(ids)) {
      expect(await sentra.query.getItem(id)).not.toBeNull();
    }
    expect(sentra.info().retention).toBe("never idle, noise never");
    await sentra.close();
  });

  it("rejects creation when the first pass fails and closes storage", async () => {
    let closed = false;
    const inner = memoryStorage();
    const storage: StorageAdapter = {
      ...storageWith({}, inner),
      pruneIdleSessions: async () => Promise.reject(new Error("prune boom")),
      close: async () => {
        closed = true;
        return inner.close();
      },
    };
    await expect(createSentra({ storage })).rejects.toThrow("prune boom");
    expect(closed).toBe(true);
  });

  it("keeps the prune error and logs a failing close after a failed first pass", async () => {
    const logger = recordingLogger();
    const storage: StorageAdapter = {
      ...storageWith({}),
      pruneIdleSessions: async () => Promise.reject(new Error("prune boom")),
      close: async () => Promise.reject(new Error("close boom")),
    };
    await expect(createSentra({ storage, logger })).rejects.toThrow("prune boom");
    expect(logger.errors).toEqual(["closing storage after failed retention failed: close boom"]);
  });

  it("stops the timer on close", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    const sentra = await createSentra();
    await sentra.close();
    expect(clearSpy).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it("lets a process that only created an instance exit", async () => {
    const cwd = fileURLToPath(new URL("..", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", "test/helpers/create-and-exit.ts"], {
      cwd,
      stdio: "ignore",
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("child did not exit within 5 s"));
      }, 5000);
      child.once("exit", (exitCode) => {
        clearTimeout(timeout);
        resolve(exitCode);
      });
    });
    expect(code).toBe(0);
  }, 10_000);
});
