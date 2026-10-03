const UNIT_MS = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
} as const;

const DURATION_RE = /^(?<amount>\d+(?:\.\d+)?)(?<unit>ms|s|m|h|d|w)$/;

function isUnit(value: string): value is keyof typeof UNIT_MS {
  return Object.hasOwn(UNIT_MS, value);
}

/** Parses `500ms`, `30s`, `60m`, `2h`, `7d`, `1w` to integer milliseconds; `null` if invalid. */
export function parseDuration(input: string): number | null {
  const groups = DURATION_RE.exec(input)?.groups;
  const amount = groups?.amount;
  const unit = groups?.unit;
  if (amount === undefined || unit === undefined || !isUnit(unit)) {
    return null;
  }
  return Math.round(Number(amount) * UNIT_MS[unit]);
}

export function parseDurationOrNever(input: string): number | "never" | null {
  return input === "never" ? "never" : parseDuration(input);
}
