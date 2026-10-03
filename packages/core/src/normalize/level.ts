import { LEVELS } from "#src/types.js";
import type { Level } from "#src/types.js";

const ALIASES: Readonly<Record<string, Level>> = {
  log: "info",
  warn: "warning",
  critical: "fatal",
};

export function levelRank(level: Level): number {
  return LEVELS.indexOf(level);
}

export function normalizeLevel(input: unknown): Level | null {
  if (typeof input !== "string") {
    return null;
  }
  const lower = input.toLowerCase();
  return LEVELS.find((level) => level === lower) ?? ALIASES[lower] ?? "info";
}
