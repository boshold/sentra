import { parseTimestampMs, toIso, toIsoTimestamp } from "#src/normalize/time.js";

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
