import { randomBytes } from "node:crypto";

const MAX_COUNTER = 4095; // 12-bit rand_a
const MAX_TIMESTAMP = 2 ** 48 - 1;

function hex(value: number, length: number): string {
  return value.toString(16).padStart(length, "0");
}

/**
 * RFC 9562 UUIDv7 generator: 48-bit ms timestamp, 12-bit `rand_a` used as a
 * randomly seeded counter (monotonic within a ms and across clock regressions),
 * variant `10`, 62 random bits.
 */
export function createUuidv7Generator(): (timestampMs?: number) => string {
  let lastMs = -1;
  let counter = 0;

  function reseed(): void {
    // Lower half of the 12-bit range, so a ms leaves room for at least 2048 increments.
    counter = randomBytes(2).readUInt16BE(0) % 2048;
  }

  return function uuidv7(timestampMs: number = Date.now()): string {
    const ms = Math.min(Math.max(Math.floor(timestampMs), 0), MAX_TIMESTAMP);
    if (ms > lastMs) {
      lastMs = ms;
      reseed();
    } else {
      counter += 1;
      if (counter > MAX_COUNTER) {
        lastMs += 1;
        reseed();
      }
    }

    const rand = randomBytes(8);
    // Variant `10` followed by 14 random bits.
    const variantHigh = 32_768 + (rand.readUInt16BE(0) % 16_384);
    const timeHex = hex(lastMs, 12);
    return [
      timeHex.slice(0, 8),
      timeHex.slice(8, 12),
      `7${hex(counter, 3)}`,
      hex(variantHigh, 4),
      rand.subarray(2, 8).toString("hex"),
    ].join("-");
  };
}

export const uuidv7 = createUuidv7Generator();
