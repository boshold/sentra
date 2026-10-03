import {
  decodeDataUrl,
  findSourceMappingUrl,
  parseSourceMap,
  resolveMapReference,
} from "#src/sourcemaps/extract.js";
import type { MapReference } from "#src/sourcemaps/extract.js";

const viteMap = {
  version: 3,
  file: "Card.vue",
  sources: ["Card.vue"],
  sourcesContent: ["<script setup lang=\"ts\">\nthrow new Error('boom')\n</script>\n"],
  names: [],
  mappings: "AAAA;AACA",
};

const nitroMap = {
  version: 3,
  file: "index.mjs",
  sources: ["../../server/api/boom.ts", null],
  names: ["boom"],
  mappings: "AAAA,SAASA",
};

function toBase64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

describe("findSourceMappingUrl", () => {
  it.each<[string, string, string | null]>([
    ["no comment", "console.log(1);\n", null],
    ["empty code", "", null],
    ["//# comment", "a();\n//# sourceMappingURL=a.js.map", "a.js.map"],
    ["//@ comment", "a();\n//@ sourceMappingURL=a.js.map", "a.js.map"],
    ["/*# */ comment", "a{}\n/*# sourceMappingURL=a.css.map */", "a.css.map"],
    ["trailing newline", "a();\n//# sourceMappingURL=a.js.map\n", "a.js.map"],
    ["CRLF", "a();\r\n//# sourceMappingURL=a.js.map\r\n", "a.js.map"],
    ["indented", "a();\n  //# sourceMappingURL=a.js.map", "a.js.map"],
    ["first line", "//# sourceMappingURL=a.js.map", "a.js.map"],
    [
      "last of two comments",
      "//# sourceMappingURL=first.map\na();\n//# sourceMappingURL=second.map\n",
      "second.map",
    ],
    [
      "string literal after real comment",
      'a();\n//# sourceMappingURL=real.map\nconst s = "//# sourceMappingURL=fake.map";\n',
      "real.map",
    ],
    ["only in string literal", "const s = '//# sourceMappingURL=fake.map';", null],
    ["empty value", "a();\n//# sourceMappingURL=\n", null],
    ["unterminated block comment", "a{}\n/*# sourceMappingURL=a.css.map", null],
  ])("%s", (_name, code, expected) => {
    expect(findSourceMappingUrl(code)).toBe(expected);
  });

  it("handles a 10 MiB inline map in under 50 ms", () => {
    const base64 = "A".repeat(10 * 1024 * 1024);
    const code = `export default 1;\n//# sourceMappingURL=data:application/json;base64,${base64}\n`;
    const start = performance.now();
    const result = findSourceMappingUrl(code);
    const elapsed = performance.now() - start;
    expect(result?.length).toBe("data:application/json;base64,".length + base64.length);
    expect(elapsed).toBeLessThan(50);
  });
});

describe("decodeDataUrl", () => {
  const json = JSON.stringify(viteMap);

  it.each<[string, string, string | null]>([
    ["base64", `data:application/json;base64,${toBase64(json)}`, json],
    ["base64 with charset", `data:application/json;charset=utf-8;base64,${toBase64(json)}`, json],
    ["uri-encoded", `data:application/json,${encodeURIComponent(json)}`, json],
    [
      "uri-encoded with charset",
      `data:application/json;charset=utf-8,${encodeURIComponent(json)}`,
      json,
    ],
    ["upper-case media type", `DATA:Application/JSON;base64,${toBase64(json)}`, json],
    ["text/html", "data:text/html,<p>hi</p>", null],
    ["broken base64", "data:application/json;base64,!!!not-base64!!!", null],
    ["truncated base64", "data:application/json;base64,eyJ2Z", null],
    ["broken uri encoding", "data:application/json,%E0%A4%A", null],
    ["no comma", "data:application/json;base64", null],
    ["not a data url", "http://localhost/a.js.map", null],
    ["unknown parameter", `data:application/json;foo;base64,${toBase64(json)}`, null],
  ])("%s", (_name, url, expected) => {
    expect(decodeDataUrl(url)).toBe(expected);
  });

  it("decodes non-ASCII content", () => {
    const content = JSON.stringify({ sourcesContent: ["const s = 'äöü €';"] });
    expect(decodeDataUrl(`data:application/json;charset=utf-8;base64,${toBase64(content)}`)).toBe(
      content,
    );
  });
});

describe("resolveMapReference", () => {
  const inlineJson = JSON.stringify(nitroMap);

  it.each<[string, string, string, MapReference | null]>([
    [
      "relative to http module with query",
      "Card.vue.map",
      "http://localhost:5173/src/components/Card.vue?t=1",
      { kind: "url", url: "http://localhost:5173/src/components/Card.vue.map" },
    ],
    [
      "absolute path on http base",
      "/assets/a.js.map",
      "http://localhost:5173/src/a.js",
      { kind: "url", url: "http://localhost:5173/assets/a.js.map" },
    ],
    [
      "absolute http ref",
      "https://127.0.0.1:3000/a.js.map",
      "http://localhost:5173/src/a.js",
      { kind: "url", url: "https://127.0.0.1:3000/a.js.map" },
    ],
    // oxlint-disable-next-line eslint/no-script-url -- untrusted map reference input
    ["javascript: on http base", "javascript:alert(1)", "http://localhost/a.js", null],
    ["file: on http base", "file:///etc/passwd", "http://localhost/a.js", null],
    [
      "sibling map on path base",
      "index.mjs.map",
      "/app/.nuxt/dev/index.mjs",
      { kind: "path", path: "/app/.nuxt/dev/index.mjs.map" },
    ],
    [
      "parent dir on path base",
      "../maps/index.mjs.map",
      "/app/.nuxt/dev/index.mjs",
      { kind: "path", path: "/app/.nuxt/maps/index.mjs.map" },
    ],
    [
      "file url base",
      "index.mjs.map",
      "file:///app/.nuxt/dev/index.mjs",
      { kind: "path", path: "/app/.nuxt/dev/index.mjs.map" },
    ],
    [
      "file url ref on path base",
      "file:///app/maps/index.mjs.map",
      "/app/.nuxt/dev/index.mjs",
      { kind: "path", path: "/app/maps/index.mjs.map" },
    ],
    ["http ref on path base", "http://localhost/a.js.map", "/app/a.js", null],
    ["relative base", "a.js.map", "app/a.js", null],
    ["empty ref", "  ", "/app/a.js", null],
    [
      "inline on http base",
      `data:application/json;base64,${toBase64(inlineJson)}`,
      "http://localhost/a.js",
      { kind: "inline", json: inlineJson },
    ],
    [
      "inline on path base",
      `data:application/json,${encodeURIComponent(inlineJson)}`,
      "/app/a.js",
      { kind: "inline", json: inlineJson },
    ],
    ["broken inline", "data:application/json;base64,%%%", "/app/a.js", null],
  ])("%s", (_name, ref, base, expected) => {
    expect(resolveMapReference(ref, base)).toEqual(expected);
  });
});

describe("parseSourceMap", () => {
  it("accepts a Vite map with sourcesContent", () => {
    expect(parseSourceMap(JSON.stringify(viteMap))).toMatchObject(viteMap);
  });

  it("accepts a Nitro-style map without sourcesContent", () => {
    const map = parseSourceMap(JSON.stringify(nitroMap));
    expect(map).toMatchObject(nitroMap);
    expect(map?.sourcesContent).toBeUndefined();
  });

  it("defaults names to an empty array and keeps unknown keys", () => {
    const map = parseSourceMap(
      JSON.stringify({ version: 3, sources: ["a.ts"], mappings: "AAAA", x_google_ignoreList: [0] }),
    );
    expect(map?.names).toEqual([]);
    expect(map).toHaveProperty("x_google_ignoreList", [0]);
  });

  it.each<[string, string]>([
    ["version 2", JSON.stringify({ ...viteMap, version: 2 })],
    [
      "index map",
      JSON.stringify({ version: 3, sections: [{ offset: { line: 0, column: 0 }, map: viteMap }] }),
    ],
    ["index map with mappings", JSON.stringify({ ...viteMap, sections: [] })],
    ["non-JSON", "{not json"],
    ["array", JSON.stringify([viteMap])],
    ["null", "null"],
    ["missing mappings", JSON.stringify({ version: 3, sources: [] })],
    ["invalid sources", JSON.stringify({ ...viteMap, sources: [1] })],
  ])("rejects %s", (_name, json) => {
    expect(parseSourceMap(json)).toBeNull();
  });
});
