import { parseSize } from "#src/util/size.js";

describe("parseSize", () => {
  it.each([
    ["20mb", 20_971_520],
    ["512kb", 524_288],
    ["1gb", 1_073_741_824],
    ["100b", 100],
    ["100", 100],
    ["1.5MB", 1_572_864],
    [" 20mb ", 20_971_520],
  ])("parses %j as %i", (input, expected) => {
    expect(parseSize(input)).toBe(expected);
  });

  it.each(["", "mb", "-1kb", "20xb"])("rejects %j", (input) => {
    expect(parseSize(input)).toBeNull();
  });
});
