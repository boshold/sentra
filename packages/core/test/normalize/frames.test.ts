import { computeInApp, normalizeFrames } from "#src/normalize/frames.js";
import type { FrameOptions } from "#src/normalize/frames.js";
import { LOOPBACK_HOSTS } from "#src/sourcemaps/hosts.js";

const NODE: FrameOptions = { platform: "node", allowedHosts: [] };
const BROWSER: FrameOptions = { platform: "javascript", allowedHosts: [] };

describe("normalizeFrames", () => {
  it("keeps Node frames as sent", () => {
    const [frame] = normalizeFrames(
      [
        {
          filename: "/app/src/index.ts",
          function: "main",
          module: "index",
          lineno: 10,
          colno: 0,
          in_app: true,
          context_line: "  boom();",
          pre_context: ["a"],
          post_context: ["b"],
        },
      ],
      NODE,
    );
    expect(frame).toEqual({
      filename: "/app/src/index.ts",
      absPath: null,
      function: "main",
      module: "index",
      lineno: 10,
      colno: 0,
      inApp: true,
      contextLine: "  boom();",
      preContext: ["a"],
      postContext: ["b"],
      positionReliable: true,
      mapped: null,
    });
  });

  it("defaults missing fields", () => {
    const [frame] = normalizeFrames([{ lineno: "1", colno: "2" }], NODE);
    expect(frame).toMatchObject({
      filename: null,
      absPath: null,
      lineno: null,
      colno: null,
      inApp: true,
      contextLine: null,
      preContext: [],
      postContext: [],
    });
  });

  it("keeps order and skips non-object entries", () => {
    const frames = normalizeFrames(
      [{ function: "outer" }, null, "x", 3, { function: "inner" }],
      NODE,
    );
    expect(frames.map((frame) => frame.function)).toEqual(["outer", "inner"]);
  });

  it.each([[undefined], [null], ["x"], [{}]])("returns [] for %j", (raw) => {
    expect(normalizeFrames(raw, NODE)).toEqual([]);
  });

  it.each([
    [{ filename: "/app/node_modules/x/index.js", in_app: false }, false],
    [{ filename: "node:internal/process/task_queues", in_app: false }, false],
    [{ filename: "/app/src/a.ts" }, true],
    [{ filename: "/app/node_modules/x/index.js" }, true],
  ])("uses sent in_app on Node for %j", (raw, expected) => {
    expect(normalizeFrames([raw], NODE)[0]?.inApp).toBe(expected);
  });

  it("recomputes in_app for browser frames from abs_path, else filename", () => {
    const frames = normalizeFrames(
      [
        {
          abs_path: "http://localhost:3000/node_modules/.vite/deps/vue.js",
          filename: "/src/a.ts",
          in_app: true,
        },
        { filename: "http://localhost:3000/node_modules/.vite/deps/vue.js", in_app: true },
        { filename: "http://localhost:3000/src/App.vue", in_app: false },
      ],
      BROWSER,
    );
    expect(frames.map((frame) => frame.inApp)).toEqual([false, false, true]);
  });
});

describe("computeInApp", () => {
  it.each([
    ["http://localhost:3000/src/App.vue", [], true],
    ["http://localhost:3000/node_modules/.vite/deps/vue.js?v=abc", [], false],
    ["http://localhost:3000/@fs/home/u/app/node_modules/x/index.js", [], false],
    ["http://localhost:3000/_nuxt/@fs/home/u/lib/a.js", [], false],
    ["https://cdn.example.com/lib.js", [], false],
    ["https://cdn.example.com/lib.js", ["cdn.example.com"], true],
    ["https://CDN.example.com/lib.js", ["cdn.example.com"], true],
    ["http://devbox:5173/src/App.vue", ["devbox:5173"], true],
    ["http://devbox:5173/src/App.vue", ["devbox"], true],
    ["http://devbox:5173/src/App.vue", ["[fe80::1]:5173"], false],
    ["http://[fe80::1]:5173/src/App.vue", ["fe80::1"], true],
    ["http://[fe80::1]:5173/src/App.vue", ["[fe80::1]:5173"], true],
    ["http://user@cdn.example.com/lib.js", ["cdn.example.com"], true],
    ["http://[bad/lib.js", [], true],
    ["http://[::1]:5173/src/a.ts", [], true],
    ["http://127.0.0.1:5173/src/a.ts", [], true],
    ["/src/a.ts", [], true],
    ["app:///main.js", [], true],
    ["file:///home/u/app/node_modules/x.js", [], false],
    [null, [], true],
  ])("browser %j with allowedHosts %j → %j", (location, allowedHosts, expected) => {
    expect(computeInApp(location, true, { platform: "javascript", allowedHosts })).toBe(expected);
  });

  it("ignores the sent value in the browser", () => {
    expect(computeInApp("http://localhost/src/a.ts", false, BROWSER)).toBe(true);
  });

  it.each([
    [true, true],
    [false, false],
    [null, true],
  ])("uses sent %j on other platforms", (sent, expected) => {
    expect(computeInApp("https://cdn.example.com/lib.js", sent, NODE)).toBe(expected);
    expect(computeInApp(null, sent, { platform: null, allowedHosts: [] })).toBe(expected);
  });

  it("exports loopback hosts", () => {
    expect(LOOPBACK_HOSTS).toEqual(["localhost", "127.0.0.1", "::1", "[::1]"]);
  });
});
