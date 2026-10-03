import { classifyLocation, frameLocation, toDisplaySource } from "#src/sourcemaps/paths.js";

describe("frameLocation", () => {
  it.each<[string, string | null, string | null, string | null]>([
    ["absPath wins", "http://localhost/a.js", "a.js", "http://localhost/a.js"],
    ["falls back to filename", null, "/app/a.js", "/app/a.js"],
    ["none", null, null, null],
  ])("%s", (_name, absPath, filename, expected) => {
    expect(frameLocation({ absPath, filename })).toBe(expected);
  });
});

describe("classifyLocation", () => {
  it.each<[string | null, string]>([
    ["http://localhost:5173/src/a.ts?t=1", "http://localhost:5173/src/a.ts?t=1"],
    ["https://127.0.0.1:3000/_nuxt/a.js", "https://127.0.0.1:3000/_nuxt/a.js"],
  ])("http: %s", (location, href) => {
    const result = classifyLocation(location);
    expect(result.kind).toBe("http");
    expect(result.kind === "http" ? result.url.href : null).toBe(href);
  });

  it.each<[string, string]>([
    ["file:///app/.nuxt/dev/index.mjs", "/app/.nuxt/dev/index.mjs"],
    ["file:///home/u/my%20app/a.ts", "/home/u/my app/a.ts"],
    ["/app/server/a.ts", "/app/server/a.ts"],
  ])("file: %s", (location, path) => {
    expect(classifyLocation(location)).toEqual({ kind: "file", path });
  });

  it.each<[string | null]>([
    ["node:internal/process/task_queues"],
    ["<anonymous>"],
    ["native"],
    ["app.js"],
    ["./src/a.ts"],
    ["webpack-internal:///./src/a.ts"],
    ["file://remote-host/a.ts"],
    ["http://"],
    [""],
    [null],
  ])("unsupported: %s", (location) => {
    expect(classifyLocation(location)).toEqual({ kind: "unsupported" });
  });
});

describe("toDisplaySource", () => {
  const root = ["/home/u/app"];

  it.each<[string, string, readonly string[], string]>([
    ["vite url", "http://localhost:5173/src/components/Card.vue", [], "src/components/Card.vue"],
    [
      "nuxt url with query",
      "http://localhost:3000/_nuxt/components/User/Card.vue?t=123",
      [],
      "components/User/Card.vue",
    ],
    ["vite @fs inside root", "http://localhost:5173/@fs/home/u/app/src/a.ts", root, "src/a.ts"],
    ["vite @fs outside root", "http://localhost:5173/@fs/other/x.ts", root, "/other/x.ts"],
    [
      "nuxt @fs inside root",
      "http://localhost:3000/_nuxt/@fs/home/u/app/layers/a.vue",
      root,
      "layers/a.vue",
    ],
    ["file url inside root", "file:///home/u/app/server/api/boom.ts", root, "server/api/boom.ts"],
    ["webpack namespace", "webpack://my-app/./src/a.ts", [], "src/a.ts"],
    ["webpack no namespace", "webpack:///src/a.ts", [], "src/a.ts"],
    ["absolute outside root", "/other/place/x.ts", root, "/other/place/x.ts"],
    ["sibling root prefix", "/home/u/app2/x.ts", root, "/home/u/app2/x.ts"],
    ["root with trailing slash", "/home/u/app/x.ts", ["/home/u/app/"], "x.ts"],
    [
      "longest root wins",
      "/home/u/app/packages/web/src/a.ts",
      ["/home/u/app", "/home/u/app/packages/web"],
      "src/a.ts",
    ],
    ["plain path with query", "/home/u/app/src/a.ts?v=abc#x", root, "src/a.ts"],
    ["relative source untouched", "../src/a.ts", root, "../src/a.ts"],
    ["encoded url path", "http://localhost:5173/src/my%20file.ts", [], "src/my file.ts"],
    [
      "encoded slash stays encoded",
      "http://localhost:5173/x/%2F..%2F..%2Fy.ts",
      [],
      "x/%2F..%2F..%2Fy.ts",
    ],
    [
      "encoded dot segment stays encoded",
      "http://localhost:5173/x/%2E%2E%2Fy.ts",
      [],
      "x/%2E%2E%2Fy.ts",
    ],
    ["invalid encoding kept", "http://localhost:5173/x/%E0%A4%A.ts", [], "x/%E0%A4%A.ts"],
  ])("%s", (_name, source, roots, expected) => {
    expect(toDisplaySource(source, roots)).toBe(expected);
  });
});
