import { durationMs, parseTimestampMs, toIso, toIsoTimestamp } from "#src/normalize/time.js";

const FALLBACK = "2026-01-01T00:00:00.000Z";

describe("parseTimestampMs", () => {
  it("parses float seconds", () => {
    expect(parseTimestampMs(1_727_950_000.123)).toBe(1_727_950_000_123);
    expect(toIso(1_727_950_000_123)).toBe("2024-10-03T10:06:40.123Z");
  });

  it("parses ISO strings", () => {
    const iso = "2024-10-03T10:06:40.123Z";
    const ms = parseTimestampMs(iso);
    expect(ms).not.toBeNull();
    expect(toIso(ms ?? 0)).toBe(iso);
  });

  it.each([["nope"], [Number.NaN], [Infinity], [1e20], [null], [undefined], [{}], [[1]]])(
    "rejects %j",
    (input) => {
      expect(parseTimestampMs(input)).toBeNull();
    },
  );
});

describe("toIsoTimestamp", () => {
  it("converts valid input", () => {
    expect(toIsoTimestamp(1_727_950_000.123, FALLBACK)).toBe("2024-10-03T10:06:40.123Z");
  });

  it.each([[undefined], ["nope"], [Number.NaN]])("falls back for %j", (input) => {
    expect(toIsoTimestamp(input, FALLBACK)).toBe(FALLBACK);
  });
});

describe("durationMs", () => {
  it.each([
    [10, 10.25, 250],
    [1_791_021_162.7234492, 1_791_021_162.7236469, 0.198],
    ["2024-10-03T10:06:40.000Z", "2024-10-03T10:06:41.500Z", 1500],
    [11, 10, 0],
    [undefined, 10, 0],
    [10, "bad", 0],
    [0, 1e308, 0],
    [-1e308, 0, 0],
    [0, 8.64e12, 8.64e15],
    [0, 8.64e12 + 1, 0],
  ])("duration from %j to %j is %j", (start, end, expected) => {
    expect(durationMs(start, end)).toBeCloseTo(expected, 3);
  });
});
