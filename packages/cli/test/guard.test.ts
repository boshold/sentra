import { createGuard } from "#src/guard.js";

describe("createGuard", () => {
  const local = createGuard({ boundHost: "127.0.0.1", allowedHosts: [] });

  it.each([
    [{ host: "localhost:8969", origin: undefined }, null],
    [{ host: "127.0.0.1", origin: undefined }, null],
    [{ host: "[::1]:8969", origin: undefined }, null],
    [{ host: "LOCALHOST:8969", origin: undefined }, null],
    [{ host: "evil.example", origin: undefined }, "forbidden_host"],
    [{ host: "localhost.evil.example", origin: undefined }, "forbidden_host"],
    [{ host: "127.0.0.1.nip.io", origin: undefined }, "forbidden_host"],
    [{ host: undefined, origin: undefined }, "forbidden_host"],
    [{ host: "", origin: undefined }, "forbidden_host"],
    [{ host: "localhost", origin: "http://localhost:5173" }, null],
    [{ host: "localhost", origin: "http://[::1]:5173" }, null],
    [{ host: "localhost", origin: "" }, null],
    [{ host: "localhost", origin: "https://evil.example" }, "forbidden_origin"],
    [{ host: "localhost", origin: "http://localhost.evil.example" }, "forbidden_origin"],
    [{ host: "localhost", origin: "null" }, "forbidden_origin"],
    [{ host: "evil.example", origin: "https://evil.example" }, "forbidden_host"],
  ])("%j → %s", (headers, code) => {
    const result = local(headers);
    if (code === null) {
      expect(result).toEqual({ ok: true });
    } else {
      expect(result).toMatchObject({ ok: false, code, message: expect.any(String) });
    }
  });

  it("allows the bound host and --allowed-host values", () => {
    const lan = createGuard({ boundHost: "192.168.1.10", allowedHosts: [] });
    expect(lan({ host: "192.168.1.10:8969", origin: undefined })).toEqual({ ok: true });
    expect(lan({ host: "192.168.1.11:8969", origin: undefined })).toMatchObject({ ok: false });

    const extra = createGuard({
      boundHost: "127.0.0.1",
      allowedHosts: ["sentra.test", "Dev.Local:3000"],
    });
    expect(extra({ host: "sentra.test", origin: undefined })).toEqual({ ok: true });
    expect(extra({ host: "localhost", origin: "http://sentra.test:3000" })).toEqual({ ok: true });
    expect(extra({ host: "dev.local:8969", origin: "http://dev.local" })).toEqual({ ok: true });
    expect(extra({ host: "other.test", origin: undefined })).toMatchObject({
      ok: false,
      code: "forbidden_host",
    });
  });

  it("brackets IPv6 bound hosts", () => {
    const v6 = createGuard({ boundHost: "fe80::1", allowedHosts: ["fd00::2"] });
    expect(v6({ host: "[fe80::1]:8969", origin: undefined })).toEqual({ ok: true });
    expect(v6({ host: "[fd00::2]", origin: "http://[fd00::2]:3000" })).toEqual({ ok: true });
  });
});
