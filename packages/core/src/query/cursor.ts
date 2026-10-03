import { SentraValidationError } from "#src/errors.js";

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const ISSUE_CURSOR_PATTERN = /^(?<lastSeenAt>\d+)\|(?<id>[0-9a-f]{16})$/;

const utf8 = new TextDecoder("utf-8", { fatal: true });

function invalidCursor(): SentraValidationError {
  return new SentraValidationError("invalid_cursor", "cursor cannot be decoded");
}

function encodeCursor(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): string {
  if (!BASE64URL_PATTERN.test(cursor)) {
    throw invalidCursor();
  }
  const bytes = Buffer.from(cursor, "base64url");
  if (bytes.toString("base64url") !== cursor) {
    throw invalidCursor();
  }
  try {
    return utf8.decode(bytes);
  } catch (error) {
    throw new SentraValidationError("invalid_cursor", "cursor is not valid UTF-8", {
      cause: error,
    });
  }
}

function encodeIssueCursor(issue: { lastSeenAt: string; id: string }): string {
  return encodeCursor(`${Date.parse(issue.lastSeenAt)}|${issue.id}`);
}

function parseIssueCursor(text: string): { lastSeenAt: number; id: string } {
  const groups = ISSUE_CURSOR_PATTERN.exec(text)?.groups;
  const lastSeenAt = groups?.lastSeenAt;
  const id = groups?.id;
  if (lastSeenAt === undefined || id === undefined) {
    throw invalidCursor();
  }
  return { lastSeenAt: Number(lastSeenAt), id };
}

export { decodeCursor, encodeCursor, encodeIssueCursor, parseIssueCursor };
