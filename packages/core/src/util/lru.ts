/** Least-recently-used cache backed by `Map` insertion order. */
export class LruCache<K, V> {
  readonly #maxEntries: number;
  // Boxed so a stored `undefined` value is distinguishable from a miss.
  readonly #map = new Map<K, { value: V }>();

  public constructor(maxEntries: number) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError(`maxEntries must be a positive integer, got ${maxEntries}`);
    }
    this.#maxEntries = maxEntries;
  }

  public get size(): number {
    return this.#map.size;
  }

  public get(key: K): V | undefined {
    const entry = this.#map.get(key);
    if (entry === undefined) {
      return undefined;
    }
    this.#map.delete(key);
    this.#map.set(key, entry);
    return entry.value;
  }

  public set(key: K, value: V): void {
    this.#map.delete(key);
    this.#map.set(key, { value });
    if (this.#map.size > this.#maxEntries) {
      const oldest = this.#map.keys().next();
      if (oldest.done !== true) {
        this.#map.delete(oldest.value);
      }
    }
  }

  public has(key: K): boolean {
    return this.#map.has(key);
  }

  public delete(key: K): boolean {
    return this.#map.delete(key);
  }

  public clear(): void {
    this.#map.clear();
  }
}
