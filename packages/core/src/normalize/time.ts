const MAX_DATE_MS = 8.64e15;

function parseTimestampMs(input: unknown): number | null {
  if (typeof input !== "number" && typeof input !== "string") {
    return null;
  }
  const ms = typeof input === "number" ? Math.round(input * 1000) : Date.parse(input);
  return Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS ? ms : null;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function toIsoTimestamp(input: unknown, fallbackIso: string): string {
  const ms = parseTimestampMs(input);
  return ms === null ? fallbackIso : toIso(ms);
}

function toMsExact(input: unknown): number | null {
  if (typeof input === "number") {
    return Number.isFinite(input) ? input * 1000 : null;
  }
  return parseTimestampMs(input);
}

/** `(end - start)` in ms (µs precision); `0` if either is missing/invalid or the result is negative. */
function durationMs(start: unknown, end: unknown): number {
  const startMs = toMsExact(start);
  const endMs = toMsExact(end);
  if (startMs === null || endMs === null || endMs < startMs) {
    return 0;
  }
  return Math.round((endMs - startMs) * 1000) / 1000;
}

export { durationMs, parseTimestampMs, toIso, toIsoTimestamp };
