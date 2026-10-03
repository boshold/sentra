import { LruCache } from "#src/util/lru.js";

describe("LruCache", () => {
  it("evicts the least recently used key beyond maxEntries", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.has("a")).toBe(false);
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
    expect(cache.size).toBe(2);
  });

  it("refreshes recency on get", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
  });

  it("updates value and recency when setting an existing key", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 10);
    cache.set("c", 3);
    expect(cache.get("a")).toBe(10);
    expect(cache.has("b")).toBe(false);
    expect(cache.size).toBe(2);
  });

  it("returns undefined for a miss and keeps stored undefined values", () => {
    const cache = new LruCache<string, number | undefined>(2);
    expect(cache.get("missing")).toBeUndefined();
    cache.set("u", undefined);
    expect(cache.has("u")).toBe(true);
    expect(cache.get("u")).toBeUndefined();
  });

  it("supports delete and clear", () => {
    const cache = new LruCache<string, number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.delete("a")).toBe(true);
    expect(cache.delete("a")).toBe(false);
    expect(cache.size).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.has("b")).toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN])("throws RangeError for maxEntries %d", (max) => {
    expect(() => new LruCache(max)).toThrow(RangeError);
  });
});
