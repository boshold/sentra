const UNIT_BYTES = {
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
} as const;

const SIZE_RE = /^(?<amount>\d+(?:\.\d+)?)(?<unit>b|kb|mb|gb)?$/;

function isUnit(value: string): value is keyof typeof UNIT_BYTES {
  return Object.hasOwn(UNIT_BYTES, value);
}

/** Parses `20mb`, `512kb`, `1gb`, `100b`, `100` (powers of 1024) to bytes; `null` if invalid. */
export function parseSize(input: string): number | null {
  const groups = SIZE_RE.exec(input.trim().toLowerCase())?.groups;
  const amount = groups?.amount;
  const unit = groups?.unit ?? "b";
  if (amount === undefined || !isUnit(unit)) {
    return null;
  }
  return Math.round(Number(amount) * UNIT_BYTES[unit]);
}
