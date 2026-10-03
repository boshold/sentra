// Fixture card-vue.served.js: served by Vite 8.3.2 + @vitejs/plugin-vue 6.0.9 (vue 3.5.43).
import { readFileSync } from "node:fs";

import { encode } from "@jridgewell/sourcemap-codec";
import type { SourceMapMappings } from "@jridgewell/sourcemap-codec";
import { originalPositionFor } from "@jridgewell/trace-mapping";

import { decodeDataUrl, findSourceMappingUrl, parseSourceMap } from "#src/sourcemaps/extract.js";
import type { RawSourceMap } from "#src/sourcemaps/extract.js";
import {
  CONTEXT_LINES,
  MAX_CONTEXT_LINE_LENGTH,
  createBudget,
  createTraceMap,
  extractContext,
  findOriginalPosition,
  mapFrame,
} from "#src/sourcemaps/mapper.js";

const CARD_URL = "http://127.0.0.1:5173/src/components/Card.vue";
const FIXTURE = new URL("../../../../test/fixtures/sourcemaps/card-vue.served.js", import.meta.url);

const noSource = { roots: [], readSource: async () => null };

function handMap(mappings: SourceMapMappings, extra: Partial<RawSourceMap> = {}): RawSourceMap {
  return { version: 3, sources: ["orig.ts"], names: [], mappings: encode(mappings), ...extra };
}

function loadFixture(): { code: string; map: RawSourceMap } {
  const code = readFileSync(FIXTURE, "utf8");
  const json = decodeDataUrl(findSourceMappingUrl(code) ?? "");
  const map = parseSourceMap(json ?? "");
  if (map === null) {
    throw new Error("fixture has no inline map");
  }
  return { code, map };
}

describe("mapFrame on the Vite Card.vue fixture", () => {
  it("maps the throw site to original 8:9 with context", async () => {
    const { code, map } = loadFixture();
    const lines = code.split("\n");
    const lineIndex = lines.findIndex((line) => line.includes("new Error("));
    const columnIndex = lines[lineIndex]?.indexOf("new Error(") ?? -1;
    expect([lineIndex + 1, columnIndex + 1]).toEqual([10, 10]);

    const mapped = await mapFrame(
      { lineno: lineIndex + 1, colno: columnIndex + 1 },
      createTraceMap(map, CARD_URL),
      noSource,
    );
    expect(mapped).toMatchObject({
      source: "src/components/Card.vue",
      absPath: CARD_URL,
      lineno: 8,
      colno: 9,
      function: null,
      contextLine: "  throw new Error('boom ' + doubled)",
    });
    expect(mapped?.preContext).toHaveLength(5);
    expect(mapped?.postContext).toHaveLength(5);
  });
});

describe("findOriginalPosition", () => {
  it("converts the 1-based colno to a 0-based column", async () => {
    const traceMap = createTraceMap(
      handMap([
        [
          [0, 0, 0, 0],
          [1, 0, 0, 10],
        ],
      ]),
      "http://localhost/a.js",
    );
    const mapped = await mapFrame({ lineno: 1, colno: 1 }, traceMap, noSource);
    expect(mapped?.colno).toBe(1);
    // Passing colno unchanged hits the next segment.
    expect(originalPositionFor(traceMap, { line: 1, column: 1 }).column).toBe(10);
  });

  it("falls back to LEAST_UPPER_BOUND", () => {
    const traceMap = createTraceMap(handMap([[[4, 0, 2, 3]]]), "http://localhost/a.js");
    expect(originalPositionFor(traceMap, { line: 1, column: 0 }).source).toBeNull();
    expect(findOriginalPosition(traceMap, 1, 1)).toEqual({
      source: "http://localhost/orig.ts",
      line: 3,
      column: 3,
    });
  });

  it("uses column 0 for colno null and keeps mapped colno null", async () => {
    const traceMap = createTraceMap(handMap([[[4, 0, 2, 3]]]), "http://localhost/a.js");
    const mapped = await mapFrame({ lineno: 1, colno: null }, traceMap, noSource);
    expect(mapped).toMatchObject({ lineno: 3, colno: null });
  });

  it("maps column 0 exactly", () => {
    const traceMap = createTraceMap(handMap([[[0, 0, 4, 0]]]), "http://localhost/a.js");
    expect(findOriginalPosition(traceMap, 1, 1)).toMatchObject({ line: 5, column: 0 });
  });

  it.each<[string, number | null]>([
    ["null", null],
    ["0", 0],
    ["past the end", 5],
    ["fractional", 1.5],
  ])("returns null for lineno %s", async (_name, lineno) => {
    const traceMap = createTraceMap(handMap([[[0, 0, 0, 0]]]), "http://localhost/a.js");
    expect(await mapFrame({ lineno, colno: 1 }, traceMap, noSource)).toBeNull();
  });
});

describe("mapFrame without sourcesContent", () => {
  const traceMap = createTraceMap(
    handMap([[[0, 0, 1, 2]]], { sources: ["boom.ts"] }),
    "file:///tmp/x/server/api/index.mjs.map",
  );

  it("reads the original source from disk", async () => {
    const readSource = vi.fn(async () => "export default () => {\n  throw new Error('boom')\n}\n");
    const mapped = await mapFrame({ lineno: 1, colno: 1 }, traceMap, {
      roots: ["/tmp/x"],
      readSource,
    });
    expect(readSource).toHaveBeenCalledWith("/tmp/x/server/api/boom.ts");
    expect(mapped).toEqual({
      source: "server/api/boom.ts",
      absPath: "/tmp/x/server/api/boom.ts",
      lineno: 2,
      colno: 3,
      function: null,
      contextLine: "  throw new Error('boom')",
      preContext: ["export default () => {"],
      postContext: ["}", ""],
    });
  });

  it("stays mapped without context when the source cannot be read", async () => {
    const mapped = await mapFrame({ lineno: 1, colno: 1 }, traceMap, {
      roots: ["/tmp/x"],
      readSource: async () => null,
    });
    expect(mapped).toMatchObject({ lineno: 2, contextLine: null, preContext: [], postContext: [] });
  });

  it("has no absPath for webpack sources", async () => {
    const webpack = createTraceMap(
      handMap([[[0, 0, 0, 0]]], { sources: ["webpack://app/./src/a.ts"] }),
      "http://localhost/a.js",
    );
    expect(await mapFrame({ lineno: 1, colno: 1 }, webpack, noSource)).toMatchObject({
      source: "src/a.ts",
      absPath: null,
    });
  });
});

describe("extractContext", () => {
  const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\r\n");

  it("strips CR and returns up to 5 lines around", () => {
    expect(extractContext(content, 10)).toEqual({
      contextLine: "line 10",
      preContext: ["line 5", "line 6", "line 7", "line 8", "line 9"],
      postContext: ["line 11", "line 12", "line 13", "line 14", "line 15"],
    });
    expect(CONTEXT_LINES).toBe(5);
  });

  it("has empty preContext on line 1 and empty postContext on the last line", () => {
    expect(extractContext(content, 1).preContext).toEqual([]);
    expect(extractContext(content, 20).postContext).toEqual([]);
  });

  it("truncates long lines", () => {
    const result = extractContext(`${"a".repeat(1000)}\n${"b".repeat(1000)}`, 1);
    expect(result.contextLine).toHaveLength(MAX_CONTEXT_LINE_LENGTH);
    expect(result.postContext[0]).toHaveLength(300);
  });

  it.each([0, 21, -1])("returns empty context for line %d", (lineno) => {
    expect(extractContext(content, lineno)).toEqual({
      contextLine: null,
      preContext: [],
      postContext: [],
    });
  });
});

describe("createBudget", () => {
  it("counts down to zero and flips exceeded", () => {
    let time = 1000;
    const budget = createBudget(100, () => time);
    expect(budget.remainingMs()).toBe(100);
    expect(budget.exceeded()).toBe(false);
    time = 1060;
    expect(budget.remainingMs()).toBe(40);
    expect(budget.exceeded()).toBe(false);
    time = 1099;
    expect(budget.exceeded()).toBe(false);
    time = 1100;
    expect(budget.remainingMs()).toBe(0);
    expect(budget.exceeded()).toBe(true);
    time = 1500;
    expect(budget.remainingMs()).toBe(0);
  });

  it("uses performance.now by default", () => {
    const budget = createBudget(10_000);
    expect(budget.remainingMs()).toBeGreaterThan(9000);
  });
});
