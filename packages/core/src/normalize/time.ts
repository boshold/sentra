const MAX_DATE_MS = 8.64e15;

export function parseTimestampMs(input: unknown): number | null {
  if (typeof input !== "number" && typeof input !== "string") {
    return null;
  }
  const ms = typeof input === "number" ? Math.round(input * 1000) : Date.parse(input);
  return Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS ? ms : null;
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

export function toIsoTimestamp(input: unknown, fallbackIso: string): string {
  const ms = parseTimestampMs(input);
  return ms === null ? fallbackIso : toIso(ms);
}
