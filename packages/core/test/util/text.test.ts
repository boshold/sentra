import {
  fenceFor,
  firstLine,
  indentContinuation,
  sanitizeText,
  singleLine,
} from "#src/util/text.js";

describe("sanitizeText", () => {
  it.each([
    ["plain\ttext\nline", "plain\ttext\nline"],
    ["\u001b[1;31mred\u001b[0m", "red"],
    ["a\u001b]8;;http://x\u0007b\u001b]8;;\u001b\\c", "abc"],
    ["open\u001b]unterminated", "open"],
    ["x\u001bMy", "xy"],
    ["a\r\nb\rc", "a\nb\nc"],
    ["\u0000\u0008\u007f\u009bz", "z"],
  ])("%j → %j", (input, expected) => {
    expect(sanitizeText(input)).toBe(expected);
  });
});

describe("firstLine", () => {
  it("returns the first sanitized line", () => {
    expect(firstLine("one\ntwo")).toBe("one");
    expect(firstLine("one\rtwo")).toBe("one");
    expect(firstLine("single")).toBe("single");
  });
});

describe("fenceFor", () => {
  it("is longer than any backtick run", () => {
    expect(fenceFor(["a"])).toBe("```");
    expect(fenceFor(["````", "``"])).toBe("`````");
  });
});

describe("singleLine / indentContinuation", () => {
  it("flattens or indents continuation lines", () => {
    expect(singleLine("a\nb\tc\r\nd")).toBe("a b c d");
    expect(indentContinuation("a\n## b\r\nc")).toBe("a\n    ## b\n    c");
  });
});
