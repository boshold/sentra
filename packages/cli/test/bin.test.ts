import { constants } from "node:os";

function fakeExit(code?: number | string | null): never {
  throw new Error(`process.exit(${String(code)})`);
}

const SIGNALS = ["SIGINT", "SIGTERM"] as const satisfies (keyof typeof constants.signals)[];

function listenerCounts(): number[] {
  return SIGNALS.map((signal) => process.listenerCount(signal));
}

let before: number[] = [];
let added: (() => void)[] = [];

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(process, "exit").mockImplementation(fakeExit);
  before = listenerCounts();
  added = [];
});

afterEach(() => {
  for (const [index, signal] of SIGNALS.entries()) {
    const listener = added[index];
    if (listener) {
      process.off(signal, listener);
    }
  }
  vi.doUnmock("#src/cli.js");
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("bin", () => {
  it.each(SIGNALS)("exits 0 on %s while the CLI is still loading", async (signal) => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.doMock("#src/cli.js", async () => {
      await gate;
      return { runCli: vi.fn(async () => 0) };
    });

    const loading = import("#src/bin.js");
    await vi.waitFor(() => {
      expect(listenerCounts()).toEqual(before.map((count) => count + 1));
    });
    expect(() => process.emit(signal)).toThrow("process.exit(0)");

    release();
    await loading;
    expect(listenerCounts()).toEqual(before);
  });

  it("hands over to the server's handlers without a moment of no listener", async () => {
    const countsInsideRunCli: number[][] = [];
    vi.doMock("#src/cli.js", () => ({
      runCli: vi.fn(async () => {
        for (const signal of SIGNALS) {
          const listener = (): void => undefined;
          added.push(listener);
          process.on(signal, listener);
        }
        countsInsideRunCli.push(listenerCounts());
        return 3;
      }),
    }));

    await import("#src/bin.js");

    expect(countsInsideRunCli).toEqual([before.map((count) => count + 2)]);
    expect(listenerCounts()).toEqual(before.map((count) => count + 1));
    expect(process.exitCode).toBe(3);
  });
});
