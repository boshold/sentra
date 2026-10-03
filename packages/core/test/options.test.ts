import { SentraConfigError } from "#src/errors.js";
import { resolveOptions } from "#src/options.js";
import { memoryStorage } from "#src/storage/memory/index.js";

function noop(): void {
  // Stub.
}

function expectInvalid(input: unknown): void {
  try {
    resolveOptions(input);
  } catch (error) {
    expect(error).toBeInstanceOf(SentraConfigError);
    expect(error).toMatchObject({ code: "invalid_option", details: expect.any(Array) });
    return;
  }
  throw new Error(`expected invalid_option for ${JSON.stringify(input)}`);
}

describe("resolveOptions", () => {
  it("applies defaults", () => {
    const options = resolveOptions(undefined);
    expect(options.storage.type).toBe("memory");
    expect({ ...options, storage: null, logger: null }).toEqual({
      storage: null,
      logger: null,
      publicUrl: null,
      retention: {
        maxIdle: "30d",
        noiseMaxAge: "7d",
        maxIdleMs: 2_592_000_000,
        noiseMaxAgeMs: 604_800_000,
      },
      limits: { maxEnvelopeBytes: 20 * 1024 * 1024, maxAttachmentBytes: 10 * 1024 * 1024 },
      rawEnvelopes: true,
      sourceMaps: {
        enabled: true,
        allowedHosts: [],
        sourceRoots: [],
        fetchTimeoutMs: 1500,
        budgetMs: 3000,
      },
    });
    expect(Object.values(options.logger).every((fn) => typeof fn === "function")).toBe(true);
    expect(() => {
      options.logger.error("silent");
    }).not.toThrow();
  });

  it("keeps given values", () => {
    const storage = memoryStorage();
    const logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    };
    const options = resolveOptions({
      storage,
      logger,
      publicUrl: "http://localhost:8969",
      retention: { maxIdle: "never", noiseMaxAge: "never" },
      limits: { maxEnvelopeBytes: 100, maxAttachmentBytes: 10 },
      rawEnvelopes: false,
      sourceMaps: {
        enabled: false,
        allowedHosts: ["cdn.example.com", "cdn.example.com:8080", "[::1]:3000", "::1"],
        sourceRoots: ["/srv/app/../app"],
        fetchTimeoutMs: 10,
        budgetMs: 20,
      },
    });
    expect(options.storage).toBe(storage);
    expect(options.logger).toBe(logger);
    expect(options.retention).toEqual({
      maxIdle: "never",
      noiseMaxAge: "never",
      maxIdleMs: null,
      noiseMaxAgeMs: null,
    });
    expect(options.sourceMaps.sourceRoots).toEqual(["/srv/app"]);
    expect(options.publicUrl).toBe("http://localhost:8969");
  });

  it.each([
    [{ retention: { maxIdle: "5x" } }],
    [{ retention: { noiseMaxAge: 7 } }],
    [{ limits: { maxEnvelopeBytes: 0 } }],
    [{ limits: { maxAttachmentBytes: -1 } }],
    [{ limits: { maxEnvelopeBytes: 1.5 } }],
    [{ publicUrl: "ftp://localhost" }],
    [{ publicUrl: "not a url" }],
    [{ publicUrl: "http://localhost/path" }],
    [{ sourceMaps: { sourceRoots: ["relative/dir"] } }],
    [{ sourceMaps: { fetchTimeoutMs: 0 } }],
    [{ sourceMaps: { allowedHosts: ["http://x/"] } }],
    [{ sourceMaps: { allowedHosts: ["a/b"] } }],
    [{ sourceMaps: { allowedHosts: ["user@x"] } }],
    [{ sourceMaps: { allowedHosts: ["cdn example"] } }],
    [{ sourceMaps: { allowedHosts: [" "] } }],
    [{ sourceMaps: { allowedHosts: [""] } }],
    [{ storage: {} }],
    [{ storage: { ...memoryStorage(), type: "redis" } }],
    [{ storage: { type: "memory", init: noop } }],
    [{ logger: { debug: () => undefined } }],
    [{ rawEnvelopes: "yes" }],
    [{ unknownOption: true }],
    ["text"],
  ])("rejects %j", (input) => {
    expectInvalid(input);
  });
});
