import zlib from "node:zlib";

import { SentraEncodingError, SentraTooLargeError } from "#src/errors.js";
import {
  decompress,
  isZstdSupported,
  mapZlibError,
  readBodyCapped,
} from "#src/ingest/decompress.js";

const text = new TextEncoder().encode('{"event_id":"abc"}\n{"type":"event"}\n{"message":"hi"}\n');

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

describe("readBodyCapped", () => {
  it("returns an empty array for a null body", async () => {
    const result = await readBodyCapped(null, 10);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.byteLength).toBe(0);
  });

  it("concatenates chunks in order", async () => {
    const result = await readBodyCapped(
      streamOf([Uint8Array.of(1, 2), Uint8Array.of(3), Uint8Array.of(4, 5)]),
      10,
    );
    expect([...result]).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns a single chunk as is", async () => {
    const chunk = Uint8Array.of(1, 2, 3);
    expect(await readBodyCapped(streamOf([chunk]), 3)).toBe(chunk);
  });

  it("accepts exactly maxBytes", async () => {
    const result = await readBodyCapped(streamOf([new Uint8Array(4), new Uint8Array(4)]), 8);
    expect(result.byteLength).toBe(8);
  });

  it("rejects maxBytes + 1 and cancels the stream", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4));
        controller.enqueue(new Uint8Array(5));
      },
      cancel,
    });
    await expect(readBodyCapped(stream, 8)).rejects.toBeInstanceOf(SentraTooLargeError);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("stops a never-ending source", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024));
      },
      cancel,
    });
    await expect(readBodyCapped(stream, 10_000)).rejects.toBeInstanceOf(SentraTooLargeError);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("decompress", () => {
  it.each([null, "", "identity", " Identity "])(
    "returns the input unchanged for %j",
    async (encoding) => {
      expect(await decompress(text, encoding, 1024)).toBe(text);
    },
  );

  it("rejects input longer than maxBytes", async () => {
    await expect(decompress(text, null, text.byteLength - 1)).rejects.toBeInstanceOf(
      SentraTooLargeError,
    );
  });

  it.each([
    ["gzip", zlib.gzipSync(text)],
    ["GZIP", zlib.gzipSync(text)],
    ["deflate", zlib.deflateSync(text)],
    ["br", zlib.brotliCompressSync(text)],
    [" br ", zlib.brotliCompressSync(text)],
  ])("round trips %j", async (encoding, compressed) => {
    const result = await decompress(compressed, encoding, 1024);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(result).equals(Buffer.from(text))).toBe(true);
  });

  it.skipIf(!isZstdSupported())("round trips zstd", async () => {
    const result = await decompress(zlib.zstdCompressSync(text), "zstd", 1024);
    expect(Buffer.from(result).equals(Buffer.from(text))).toBe(true);
  });

  it("treats zstd as unsupported when the runtime lacks it", async () => {
    const original = Object.getOwnPropertyDescriptor(zlib, "zstdDecompress");
    Object.defineProperty(zlib, "zstdDecompress", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    try {
      expect(isZstdSupported()).toBe(false);
      await expect(decompress(Uint8Array.of(1), "zstd", 1024)).rejects.toBeInstanceOf(
        SentraEncodingError,
      );
    } finally {
      if (original) {
        Object.defineProperty(zlib, "zstdDecompress", original);
      }
    }
  });

  const zeros = new Uint8Array(1024 * 1024);
  const bombs: { encoding: string; compress: () => Uint8Array }[] = [
    { encoding: "gzip", compress: () => zlib.gzipSync(zeros) },
    { encoding: "br", compress: () => zlib.brotliCompressSync(zeros) },
  ];

  async function expectBombStopped(encoding: string, bomb: Uint8Array): Promise<void> {
    expect(bomb.byteLength).toBeLessThan(64 * 1024);
    await expect(decompress(bomb, encoding, 64 * 1024)).rejects.toBeInstanceOf(SentraTooLargeError);
  }

  it.each(bombs)("stops a $encoding decompression bomb", async ({ encoding, compress }) => {
    await expectBombStopped(encoding, compress());
  });

  it.skipIf(!isZstdSupported())("stops a zstd decompression bomb", async () => {
    await expectBombStopped("zstd", zlib.zstdCompressSync(zeros));
  });

  it("rejects a corrupt stream", async () => {
    await expect(decompress(Uint8Array.of(1, 2, 3, 4), "gzip", 1024)).rejects.toBeInstanceOf(
      SentraEncodingError,
    );
  });

  it("rejects a truncated gzip stream", async () => {
    const compressed = zlib.gzipSync(text);
    await expect(
      decompress(compressed.subarray(0, compressed.byteLength - 8), "gzip", 1024),
    ).rejects.toBeInstanceOf(SentraEncodingError);
  });

  it.each(["compress", "gzip, br", "x-custom"])(
    "rejects unsupported encoding %j",
    async (encoding) => {
      const rejection = decompress(text, encoding, 1024);
      await expect(rejection).rejects.toBeInstanceOf(SentraEncodingError);
      await expect(rejection).rejects.toThrow(encoding);
    },
  );
});

describe("mapZlibError", () => {
  it("maps a Bun-style RangeError to SentraTooLargeError", () => {
    expect(
      mapZlibError(new RangeError("output is larger than maxOutputLength"), "gzip", 1),
    ).toBeInstanceOf(SentraTooLargeError);
  });

  it("maps other errors to SentraEncodingError with cause", () => {
    const cause = new Error("boom");
    const error = mapZlibError(cause, "gzip", 1);
    expect(error).toBeInstanceOf(SentraEncodingError);
    expect(error.cause).toBe(cause);
  });
});
