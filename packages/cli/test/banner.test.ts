import { renderBanner } from "#src/banner.js";
import type { BannerInput } from "#src/banner.js";

const SQLITE: BannerInput = {
  version: "0.1.0",
  host: "127.0.0.1",
  port: 8969,
  publicUrl: "http://localhost:8969",
  storage: {
    type: "sqlite",
    driver: "better-sqlite3",
    path: "/home/u/.local/share/sentra/sentra.db",
  },
  retention: "30d idle, noise 7d",
  maxItems: 10_000,
  api: true,
  mcp: true,
  lanAddresses: ["192.168.1.10"],
  homeDir: "/home/u",
};

describe("renderBanner", () => {
  it("renders the default sqlite banner", () => {
    expect(renderBanner(SQLITE)).toEqual([
      "sentra 0.1.0  listening on http://127.0.0.1:8969",
      "storage       sqlite ~/.local/share/sentra/sentra.db (driver: better-sqlite3, retention: 30d idle, noise 7d)",
      "DSN           http://sentra@localhost:8969/1",
      "scoped DSN    http://sentra@localhost:8969/<project>/<session>/<service>/1",
      "query API     http://127.0.0.1:8969/api/sentra",
      "MCP           http://127.0.0.1:8969/mcp",
    ]);
  });

  it("renders memory storage and keeps paths outside home", () => {
    const memory = renderBanner({
      ...SQLITE,
      storage: { type: "memory", driver: null, path: null },
      retention: "never idle, noise never",
    });
    expect(memory[1]).toBe(
      "storage       memory (max 10000 items, retention: never idle, noise never)",
    );
    const other = renderBanner({
      ...SQLITE,
      storage: { ...SQLITE.storage, path: "/home/user2/s.db" },
    });
    expect(other[1]).toContain(" /home/user2/s.db ");
  });

  it("adds LAN DSNs and a warning for wildcard hosts", () => {
    const lines = renderBanner({ ...SQLITE, host: "0.0.0.0" });
    expect(lines).toContain("DSN           http://sentra@192.168.1.10:8969/1");
    expect(lines.at(-1)).toBe(
      "warning       ingest, query API and MCP are reachable from the network",
    );
    expect(lines[0]).toBe("sentra 0.1.0  listening on http://0.0.0.0:8969");
    expect(renderBanner({ ...SQLITE, host: "::" })[0]).toBe(
      "sentra 0.1.0  listening on http://[::]:8969",
    );
    expect(renderBanner({ ...SQLITE, host: "192.168.1.10" })).toHaveLength(6);
  });

  it("drops disabled routes and brackets IPv6 hosts", () => {
    const lines = renderBanner({ ...SQLITE, api: false, mcp: false, host: "::1" });
    expect(lines.some((entry) => entry.startsWith("query API"))).toBe(false);
    expect(lines.some((entry) => entry.startsWith("MCP"))).toBe(false);
    expect(lines[0]).toBe("sentra 0.1.0  listening on http://[::1]:8969");
  });
});
