import { VERSION } from "#src/index.js";

describe("VERSION", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("falls back to dev when no build version is defined", () => {
    expect(VERSION).toBe("dev");
  });

  it("uses the injected build version", async () => {
    vi.stubGlobal("__VERSION__", "1.2.3");
    vi.resetModules();
    const mod = await import("#src/util/version.js");
    expect(mod.VERSION).toBe("1.2.3");
  });
});
