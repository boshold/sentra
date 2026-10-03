import { createLimiter } from "#src/util/limit.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
}

describe("createLimiter", () => {
  it("runs at most max tasks at once, in call order", async () => {
    const limit = createLimiter(2);
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const started: number[] = [];
    const runs = gates.map(async (gate, index) =>
      limit(async () => {
        started.push(index);
        await gate.promise;
        return index;
      }),
    );
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    gates[1]?.resolve();
    await vi.waitFor(() => {
      expect(started).toEqual([0, 1, 2]);
    });
    for (const gate of gates) {
      gate.resolve();
    }
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3]);
    expect(started).toEqual([0, 1, 2, 3]);
  });

  it("never exceeds max when a call lands right after a release", async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;
    const gates = [deferred(), deferred(), deferred(), deferred()];
    async function run(gate: { promise: Promise<void> }): Promise<void> {
      return limit(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await gate.promise;
        active -= 1;
      });
    }
    const runs = gates.slice(0, 3).map(run);
    await Promise.resolve();
    gates[0]?.resolve();
    await gates[0]?.promise;
    await Promise.resolve();
    runs.push(run(gates[3] ?? deferred()));
    await vi.waitFor(() => {
      expect(active).toBe(2);
    });
    for (const gate of gates) {
      gate.resolve();
    }
    await Promise.all(runs);
    expect(peak).toBe(2);
  });

  it("frees the slot when a task rejects", async () => {
    const limit = createLimiter(1);
    const failure = new Error("boom");
    await expect(limit(async () => Promise.reject(failure))).rejects.toBe(failure);
    expect(await limit(async () => "next")).toBe("next");
  });
});
