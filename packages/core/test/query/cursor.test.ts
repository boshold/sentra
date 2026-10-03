import { SentraValidationError } from "#src/errors.js";
import {
  decodeCursor,
  encodeCursor,
  encodeIssueCursor,
  parseIssueCursor,
} from "#src/query/cursor.js";

function expectInvalidCursor(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SentraValidationError);
    expect(error).toMatchObject({ code: "invalid_cursor" });
    return;
  }
  throw new Error("expected invalid_cursor");
}

describe("encodeCursor / decodeCursor", () => {
  it.each(["019a4f0e-7b1c-7d2e-8f00-0123456789ab", "a", "ä?/+=", "x".repeat(100)])(
    "round trips %j",
    (text) => {
      const cursor = encodeCursor(text);
      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeCursor(cursor)).toBe(text);
    },
  );

  it("uses the URL-safe alphabet without padding", () => {
    const cursor = encodeCursor("ûÿþ?>");
    expect(cursor).not.toMatch(/[+/=]/);
  });

  it.each(["", "%%%", "abc=", "a+b/", "A", "_w"])("rejects %j", (cursor) => {
    expectInvalidCursor(() => decodeCursor(cursor));
  });
});

describe("issue cursor", () => {
  it("round trips", () => {
    const cursor = encodeIssueCursor({
      lastSeenAt: "2026-10-03T10:00:00.000Z",
      id: "0123456789abcdef",
    });
    expect(parseIssueCursor(decodeCursor(cursor))).toEqual({
      lastSeenAt: Date.parse("2026-10-03T10:00:00.000Z"),
      id: "0123456789abcdef",
    });
  });

  it.each([
    "",
    "123",
    "123|xyz",
    "abc|0123456789abcdef",
    "1|0123456789ABCDEF",
    "1|0123456789abcdef0",
  ])("rejects %j", (text) => {
    expectInvalidCursor(() => parseIssueCursor(text));
  });
});
