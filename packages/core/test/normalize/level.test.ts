import { levelRank, normalizeLevel } from "#src/normalize/level.js";
import { LEVELS } from "#src/types.js";
import type { Level } from "#src/types.js";

const mapped: [unknown, Level | null][] = [
  ["trace", "trace"],
  ["debug", "debug"],
  ["info", "info"],
  ["warning", "warning"],
  ["error", "error"],
  ["fatal", "fatal"],
  ["log", "info"],
  ["warn", "warning"],
  ["critical", "fatal"],
  ["WARN", "warning"],
  ["Error", "error"],
  ["bogus", "info"],
  ["", "info"],
  [undefined, null],
  [null, null],
  [7, null],
];

describe("normalizeLevel", () => {
  it.each(mapped)("maps %j to %j", (input, expected) => {
    expect(normalizeLevel(input)).toBe(expected);
  });
});

describe("levelRank", () => {
  it("ranks levels in LEVELS order", () => {
    expect(LEVELS.map((level) => levelRank(level))).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
