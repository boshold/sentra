import { formatFrameLocation, renderFrameLines, renderStackMarkdown } from "#src/index.js";

import { frame, libraryFrame, mapped } from "./factories.js";

describe("formatFrameLocation", () => {
  it.each([
    ["mapped", frame({ mapped: mapped() }), "components/User/Profile/Card.vue:42:13"],
    [
      "mapped without column",
      frame({ mapped: mapped({ colno: null }) }),
      "components/User/Profile/Card.vue:42",
    ],
    [
      "unreliable",
      frame({ absPath: "/app/pages/index.vue", lineno: 10, colno: 3, positionReliable: false }),
      "/app/pages/index.vue:~10:3",
    ],
    ["filename fallback", frame({ filename: "app.js", lineno: 5, colno: null }), "app.js:5"],
    ["no position", frame({ lineno: null, colno: 7 }), "app.js"],
    ["unknown", frame({ filename: null, absPath: null, lineno: null }), "<unknown>"],
  ])("%s", (_name, input, expected) => {
    expect(formatFrameLocation(input)).toBe(expected);
  });
});

describe("renderFrameLines", () => {
  it("prints in-app frames crashing first and collapses library frames", () => {
    const frames = [
      ...Array.from({ length: 6 }, () => libraryFrame()),
      frame({ function: "setup", mapped: mapped({ lineno: 12, colno: 5 }) }),
      frame({ function: "x", mapped: mapped({ function: "loadUser" }) }),
    ];
    expect(renderFrameLines(frames)).toEqual([
      "at loadUser  components/User/Profile/Card.vue:42:13",
      "at setup     components/User/Profile/Card.vue:12:5",
      "… 6 more frames (library)",
    ]);
  });

  it("limits in-app frames to maxInApp", () => {
    const frames = Array.from({ length: 7 }, (_, index) => frame({ function: `f${index}` }));
    const lines = renderFrameLines(frames);
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe("at f6  app.js:1:1");
    expect(lines.at(-1)).toBe("… 2 more frames");
    expect(renderFrameLines(frames, { maxInApp: 2 }).at(-1)).toBe("… 5 more frames");
  });

  it("treats all frames as in-app when none is", () => {
    const lines = renderFrameLines([libraryFrame({ function: null }), libraryFrame()]);
    expect(lines).toEqual([
      "at callWithErrorHandling  node_modules/vue/index.js:1:1",
      "at <anonymous>            node_modules/vue/index.js:1:1",
    ]);
  });

  it("returns no lines for an empty stack", () => {
    expect(renderFrameLines([])).toEqual([]);
  });
});

describe("renderStackMarkdown", () => {
  it("prints context for reliable in-app frames and collapses library runs", () => {
    const frames = [
      libraryFrame(),
      libraryFrame(),
      frame({
        function: "main",
        lineno: 10,
        contextLine: "  run();",
        preContext: ["function main() {"],
        postContext: ["}"],
      }),
      libraryFrame(),
      frame({
        function: "ssr",
        absPath: "/app/pages/index.vue",
        lineno: 10,
        colno: 3,
        positionReliable: false,
        contextLine: "ignored",
      }),
      frame({
        function: "raw",
        mapped: mapped({
          lineno: 9,
          contextLine: "const user = props.user.id;",
          preContext: ["// ```"],
          postContext: [],
        }),
        contextLine: "minified",
      }),
    ];
    expect(renderStackMarkdown(frames)).toMatchInlineSnapshot(`
      "at raw (components/User/Profile/Card.vue:9:13)
      \`\`\`\`
        8 | // \`\`\`
      > 9 | const user = props.user.id;
      \`\`\`\`
      at ssr (/app/pages/index.vue:~10:3)
      … 1 library frame
      at main (app.js:10:1)
      \`\`\`
         9 | function main() {
      > 10 |   run();
        11 | }
      \`\`\`
      … 2 library frames"
    `);
  });

  it("skips the code block without a context line", () => {
    expect(renderStackMarkdown([frame()])).toBe("at fn (app.js:1:1)");
    expect(renderStackMarkdown([])).toBe("");
  });
});
