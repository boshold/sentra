import { promisify } from "node:util";
import zlib from "node:zlib";

import { SentraEncodingError, SentraTooLargeError } from "#src/errors.js";
import type { SentraError } from "#src/errors.js";

type OneShot = (buffer: Uint8Array, options: { maxOutputLength: number }) => Promise<Buffer>;

function tooLarge(maxBytes: number): SentraTooLargeError {
  return new SentraTooLargeError(`body exceeds ${maxBytes} bytes`, { details: { maxBytes } });
}

// Read per call so tests can stub `zlib.zstdDecompress` away.
function zstdAvailable(): boolean {
  return typeof zlib.zstdDecompress === "function";
}

function decompressorFor(encoding: string): OneShot | null {
  switch (encoding) {
    case "gzip": {
      return promisify(zlib.gunzip);
    }
    case "deflate": {
      return promisify(zlib.inflate);
    }
    case "br": {
      return promisify(zlib.brotliDecompress);
    }
    case "zstd": {
      return zstdAvailable() ? promisify(zlib.zstdDecompress) : null;
    }
    default: {
      return null;
    }
  }
}

function isTooLargeError(error: unknown): boolean {
  if (error instanceof Error && "code" in error && error.code === "ERR_BUFFER_TOO_LARGE") {
    return true;
  }
  // Bun reports the output limit differently.
  return (
    error instanceof RangeError &&
    (error.message.includes("maxOutputLength") || error.message.includes("larger than"))
  );
}

/** Reads the whole stream, cancelling it as soon as more than `maxBytes` arrive. */
export async function readBodyCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array> {
  if (body === null) {
    return new Uint8Array(0);
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw tooLarge(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return chunks.length === 1 && chunks[0] !== undefined ? chunks[0] : Buffer.concat(chunks, total);
}

export function isZstdSupported(): boolean {
  return zstdAvailable();
}

export function mapZlibError(error: unknown, encoding: string, maxBytes: number): SentraError {
  if (isTooLargeError(error)) {
    return new SentraTooLargeError(`decompressed body exceeds ${maxBytes} bytes`, {
      details: { maxBytes },
      cause: error,
    });
  }
  return new SentraEncodingError(`corrupt ${encoding} stream`, { cause: error });
}

/** Decodes `Content-Encoding` with one-shot zlib calls; output never exceeds `maxBytes`. */
export async function decompress(
  body: Uint8Array,
  contentEncoding: string | null,
  maxBytes: number,
): Promise<Uint8Array> {
  if (body.byteLength > maxBytes) {
    throw tooLarge(maxBytes);
  }
  const encoding = (contentEncoding ?? "").trim().toLowerCase();
  if (encoding === "" || encoding === "identity") {
    return body;
  }
  const decompressor = decompressorFor(encoding);
  if (decompressor === null) {
    throw new SentraEncodingError(
      `unsupported Content-Encoding ${JSON.stringify(contentEncoding)}`,
      { details: { contentEncoding } },
    );
  }
  try {
    return await decompressor(body, { maxOutputLength: maxBytes });
  } catch (error) {
    throw mapZlibError(error, encoding, maxBytes);
  }
}
