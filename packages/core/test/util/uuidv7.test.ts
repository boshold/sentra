import { createUuidv7Generator, uuidv7 } from "#src/util/uuidv7.js";

const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function timestampOf(id: string): number {
  return Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);
}

function expectIncreasing(ids: string[]): void {
  for (let i = 1; i < ids.length; i += 1) {
    const prev = ids[i - 1] ?? "";
    const current = ids[i] ?? "";
    expect(current > prev, `${current} > ${prev}`).toBe(true);
  }
}

describe("uuidv7", () => {
  it("returns a lowercase RFC 9562 v7 UUID", () => {
    expect(uuidv7()).toMatch(UUIDV7_RE);
  });

  it("encodes the passed timestamp in the first 48 bits", () => {
    const generate = createUuidv7Generator();
    const ts = 1_759_480_000_123;
    expect(timestampOf(generate(ts))).toBe(ts);
  });

  it("generates 10 000 strictly increasing ids", () => {
    const generate = createUuidv7Generator();
    const ids = Array.from({ length: 10_000 }, () => generate());
    for (const id of ids) {
      expect(id).toMatch(UUIDV7_RE);
    }
    expectIncreasing(ids);
  });

  it("stays increasing when the clock repeats or goes backwards", () => {
    const generate = createUuidv7Generator();
    const ids = [1000, 1000, 999, 1000].map((ts) => generate(ts));
    expectIncreasing(ids);
    expect(ids.map(timestampOf)).toEqual([1000, 1000, 1000, 1000]);
  });

  it("advances the timestamp when the counter overflows", () => {
    const generate = createUuidv7Generator();
    const ids = Array.from({ length: 5000 }, () => generate(1000));
    expectIncreasing(ids);
    expect(timestampOf(ids.at(-1) ?? "")).toBeGreaterThan(1000);
  });
});
