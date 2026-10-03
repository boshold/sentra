import { parseDuration, parseDurationOrNever } from "#src/query/duration.js";

const valid: [string, number][] = [
  ["500ms", 500],
  ["30s", 30_000],
  ["60m", 3_600_000],
  ["2h", 7_200_000],
  ["7d", 604_800_000],
  ["1w", 604_800_000],
  ["1.5h", 5_400_000],
];
const invalid = ["", "10", "m", "-5m", "5 m", "5y", "never"];

describe("parseDuration", () => {
  it.each(valid)("parses %j as %i", (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it.each(invalid)("rejects %j", (input) => {
    expect(parseDuration(input)).toBeNull();
  });
});

describe("parseDurationOrNever", () => {
  it("accepts never", () => {
    expect(parseDurationOrNever("never")).toBe("never");
  });

  it.each(valid)("parses %j as %i", (input, expected) => {
    expect(parseDurationOrNever(input)).toBe(expected);
  });

  it.each(invalid.filter((input) => input !== "never"))("rejects %j", (input) => {
    expect(parseDurationOrNever(input)).toBeNull();
  });
});
