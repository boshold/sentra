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

  it("frees the slot when a task rejects", async () => {
    const limit = createLimiter(1);
    const failure = new Error("boom");
    await expect(limit(async () => Promise.reject(failure))).rejects.toBe(failure);
    expect(await limit(async () => "next")).toBe("next");
  });
});
