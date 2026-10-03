import type { StartConfig } from "#src/cli.js";
import {
  createStderrLogger,
  defaultDbPath,
  isLoopbackHost,
  isUnspecifiedHost,
  lanAddresses,
  resolveStartConfig,
  runCli,
  toSentraOptions,
} from "#src/cli.js";

interface Captured {
  stdout: string;
  stderr: string;
}

function capture(): { output: Captured; restore: () => void } {
  const output: Captured = { stdout: "", stderr: "" };
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.stdout += String(chunk);
    return true;
  });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    output.stderr += String(chunk);
    return true;
  });
  return {
    output,
    restore: () => {
      stdout.mockRestore();
      stderr.mockRestore();
    },
  };
}

async function run(
  argv: string[],
  start?: (config: StartConfig) => Promise<void>,
): Promise<Captured & { code: number }> {
  const { output, restore } = capture();
  try {
    const code = await runCli(argv, start === undefined ? {} : { start });
    return { ...output, code };
  } finally {
    restore();
  }
}

describe("resolveStartConfig", () => {
  it("applies the defaults", () => {
    const config = resolveStartConfig({}, { XDG_DATA_HOME: "/data" }, "/work");
    expect(config).toEqual({
      host: "127.0.0.1",
      port: 8969,
      publicUrl: null,
      storage: "sqlite",
      dbPath: "/data/sentra/sentra.db",
      sqliteDriver: "auto",
      maxItems: 10_000,
      retention: "30d",
      noiseRetention: "7d",
      maxBodyBytes: 20_971_520,
      maxAttachmentBytes: 10_485_760,
      rawEnvelopes: true,
      sourceMaps: true,
      sourceMapHosts: [],
      sourceRoots: ["/work"],
      allowedHosts: [],
      api: true,
      mcp: true,
      show: ["error", "message", "log"],
      minLevel: null,
      project: null,
      session: null,
      service: null,
      format: "pretty",
      quiet: false,
      color: true,
      logLevel: "warn",
    });
  });

  it("maps given flags", () => {
    const config = resolveStartConfig(
      {
        db: "data/s.db",
        sourceRoot: ["app", "/abs"],
        retention: "never",
        noiseRetention: "never",
        maxBody: "1mb",
        show: "all",
        noRaw: true,
        noSourceMaps: true,
        noApi: true,
        noMcp: true,
        noColor: true,
        minLevel: "warning",
        project: "my-app",
        allowedHost: ["dev.local:3000"],
        publicUrl: "http://192.168.1.10:8969",
      },
      {},
      "/work",
    );
    expect(config).toMatchObject({
      dbPath: "/work/data/s.db",
      sourceRoots: ["/work/app", "/abs"],
      retention: "never",
      noiseRetention: "never",
      maxBodyBytes: 1_048_576,
      show: "all",
      rawEnvelopes: false,
      sourceMaps: false,
      api: false,
      mcp: false,
      color: false,
      minLevel: "warning",
      project: "my-app",
      allowedHosts: ["dev.local:3000"],
      publicUrl: "http://192.168.1.10:8969",
    });
    expect(resolveStartConfig({ show: "log, error,log" }, {}, "/w").show).toEqual(["log", "error"]);
  });
});

describe("defaultDbPath", () => {
  it("uses XDG_DATA_HOME or the home fallback", () => {
    expect(defaultDbPath({ XDG_DATA_HOME: "/x" }, "/home/u")).toBe("/x/sentra/sentra.db");
    expect(defaultDbPath({}, "/home/u")).toBe("/home/u/.local/share/sentra/sentra.db");
    expect(defaultDbPath({ XDG_DATA_HOME: "relative" }, "/home/u")).toBe(
      "/home/u/.local/share/sentra/sentra.db",
    );
  });
});

describe("runCli flag validation", () => {
  it.each([
    [["--port", "abc"], "--port"],
    [["--host", "http://localhost"], "--host"],
    [["--host", "localhost:8969"], "--host"],
    [["--host", "127.0.0.1:80"], "--host"],
    [["--host", "a b"], "--host"],
    [["--host", "host/path"], "--host"],
    [["--host", "user@host"], "--host"],
    [["--host", ""], "--host"],
    [["--host", "[::1]:80"], "--host"],
    [["--port", "70000"], "--port"],
    [["--port", "1.5"], "--port"],
    [["--storage", "pg"], "--storage"],
    [["--sqlite-driver", "bun"], "--sqlite-driver"],
    [["--retention", "5x"], "--retention"],
    [["--noise-retention", "soon"], "--noise-retention"],
    [["--max-body", "10xb"], "--max-body"],
    [["--max-attachment", "0"], "--max-attachment"],
    [["--max-items", "0"], "--max-items"],
    [["--show", "error,foo"], "--show"],
    [["--show", "all,error"], "--show"],
    [["--min-level", "loud"], "--min-level"],
    [["--format", "xml"], "--format"],
    [["--log-level", "trace"], "--log-level"],
    [["--project", "a b"], "--project"],
    [["--service", "a/b"], "--service"],
    [["--public-url", "nope"], "--public-url"],
    [["--public-url", "http://localhost:8969/path"], "--public-url"],
    [["--allowed-host", "http://x/"], "--allowed-host"],
    [["--source-map-host", "user@x"], "--source-map-host"],
    [["--unknown-flag"], "--unknown-flag"],
    [["start", "--bogus"], "--bogus"],
    [["stray"], "stray"],
  ])("%j → exit 2", async (argv, flag) => {
    const start = vi.fn(async () => undefined);
    const result = await run(argv, start);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/^sentra: /);
    expect(result.stderr).toContain(flag);
    expect(start).not.toHaveBeenCalled();
  });

  it("accepts never retention", async () => {
    const start = vi.fn(async (_config: StartConfig) => undefined);
    const result = await run(["--retention", "never", "--noise-retention", "never"], start);
    expect(result.code).toBe(0);
    expect(start.mock.calls[0]?.[0]).toMatchObject({ retention: "never", noiseRetention: "never" });
  });

  it("calls start for the root command and for start", async () => {
    for (const argv of [
      ["start", "--port", "0"],
      ["--port", "0"],
      ["-p", "0", "-q", "--no-raw"],
    ]) {
      const start = vi.fn(async (_config: StartConfig) => undefined);
      const result = await run(argv, start);
      expect(result.code).toBe(0);
      expect(start).toHaveBeenCalledTimes(1);
      expect(start.mock.calls[0]?.[0].port).toBe(0);
    }
    const start = vi.fn(async (_config: StartConfig) => undefined);
    await run(["-p", "0", "-q", "--no-raw", "--source-root", "a", "--source-root", "b"], start);
    expect(start.mock.calls[0]?.[0]).toMatchObject({
      quiet: true,
      rawEnvelopes: false,
      sourceRoots: [`${process.cwd()}/a`, `${process.cwd()}/b`],
    });
  });

  it("maps start failures to exit 1", async () => {
    const result = await run(["--port", "0"], async () => {
      throw new Error("port in use");
    });
    expect(result).toMatchObject({ code: 1, stderr: "sentra: port in use\n" });
    const unimplemented = await run(["--port", "0"]);
    expect(unimplemented.code).toBe(1);
  });
});

describe("sentra dsn", () => {
  it.each([
    [
      ["dsn", "--project", "my-app", "--service", "web"],
      "http://sentra@localhost:8969/my-app/_/web/1",
    ],
    [
      ["dsn", "--project", "my-app", "--session", "3f9a1c", "--service", "web"],
      "http://sentra@localhost:8969/my-app/3f9a1c/web/1",
    ],
    [["dsn", "--public-url", "http://192.168.1.10:8969"], "http://sentra@192.168.1.10:8969/1"],
    [["dsn"], "http://sentra@localhost:8969/1"],
  ])("%j", async (argv, dsn) => {
    const result = await run(argv);
    expect(result).toEqual({ code: 0, stdout: `${dsn}\n`, stderr: "" });
  });

  it.each([
    [["dsn", "--project", "a/b"]],
    [["dsn", "--public-url", "ftp://x"]],
    [["dsn", "--port", "1"]],
    [["dsn", "x"]],
  ])("%j → exit 2", async (argv) => {
    const result = await run(argv);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^sentra: /);
  });
});

describe("isLoopbackHost", () => {
  it.each([
    ["localhost", true],
    ["LOCALHOST", true],
    ["127.0.0.1", true],
    ["127.1.2.3", true],
    ["::1", true],
    ["[::1]", true],
    ["0.0.0.0", false],
    ["192.168.1.10", false],
    ["::", false],
    ["0:0:0:0:0:0:0:1", true],
    ["0x7f.1", true],
    ["localhost.example.com", false],
  ])("%s → %s", (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });
});

describe("host flag", () => {
  it.each([
    ["localhost", "localhost"],
    ["0.0.0.0", "0.0.0.0"],
    ["::", "::"],
    ["::1", "::1"],
    ["[::1]", "::1"],
    ["fe80::1", "fe80::1"],
    ["dev.local", "dev.local"],
  ])("accepts %s", (host, expected) => {
    expect(resolveStartConfig({ host }, {}, "/w").host).toBe(expected);
  });
});

describe("isUnspecifiedHost", () => {
  it.each([
    ["0.0.0.0", true],
    ["::", true],
    ["[::]", true],
    ["::0", true],
    ["0:0:0:0:0:0:0:0", true],
    ["0", true],
    ["::1", false],
    ["127.0.0.1", false],
    ["192.168.1.10", false],
    ["localhost", false],
  ])("%s → %s", (host, expected) => {
    expect(isUnspecifiedHost(host)).toBe(expected);
  });
});

describe("toSentraOptions", () => {
  function config(flags: Record<string, unknown>): StartConfig {
    return resolveStartConfig(flags, {}, "/work");
  }

  it("maps storage, retention, limits and source maps", () => {
    const options = toSentraOptions(
      config({ storage: "memory", sourceMapHost: ["cdn.local"], maxAttachment: "1kb" }),
    );
    expect(options.storage?.type).toBe("memory");
    expect(options).toMatchObject({
      retention: { maxIdle: "30d", noiseMaxAge: "7d" },
      limits: { maxEnvelopeBytes: 20_971_520, maxAttachmentBytes: 1024 },
      rawEnvelopes: true,
      sourceMaps: { enabled: true, allowedHosts: ["cdn.local"], sourceRoots: ["/work"] },
    });
    expect(options).not.toHaveProperty("publicUrl");
    expect(toSentraOptions(config({ db: "/tmp/never-opened/s.db" })).storage?.type).toBe("sqlite");
    expect(toSentraOptions(config({ publicUrl: "http://localhost:1" })).publicUrl).toBe(
      "http://localhost:1",
    );
  });

  it("adds the bound host and LAN addresses for non-loopback binds", () => {
    const wildcard = toSentraOptions(config({ host: "0.0.0.0", sourceMapHost: ["cdn.local"] }));
    const hosts = wildcard.sourceMaps?.allowedHosts ?? [];
    expect(hosts).toEqual(expect.arrayContaining(["cdn.local", ...lanAddresses()]));
    expect(hosts).not.toContain("0.0.0.0");
    for (const host of ["::", "::0", "0:0:0:0:0:0:0:0", "[::]"]) {
      const v6 = toSentraOptions(config({ host })).sourceMaps?.allowedHosts ?? [];
      expect(v6).toEqual([...new Set(lanAddresses())]);
    }
    const bound = toSentraOptions(config({ host: "192.168.77.5" }));
    expect(bound.sourceMaps?.allowedHosts).toContain("192.168.77.5");
    const loopback = toSentraOptions(config({ sourceMapHost: ["cdn.local"] }));
    expect(loopback.sourceMaps?.allowedHosts).toEqual(["cdn.local"]);
  });
});

describe("lanAddresses", () => {
  it("returns IPv4 addresses only", () => {
    for (const address of lanAddresses()) {
      expect(address).toMatch(/^\d{1,3}(?:\.\d{1,3}){3}$/);
      expect(address.startsWith("127.")).toBe(false);
    }
  });
});

describe("createStderrLogger", () => {
  it("filters by level", () => {
    const { output, restore } = capture();
    try {
      const logger = createStderrLogger("warn");
      logger.debug("d");
      logger.info("i");
      logger.warn("w", { a: 1 });
      logger.error("e");
    } finally {
      restore();
    }
    expect(output.stderr).toBe("sentra warn: w { a: 1 }\nsentra error: e\n");
  });
});
