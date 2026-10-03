import { SentraScopeError } from "#src/errors.js";
import {
  DEFAULT_SEGMENT,
  isIngestPath,
  parseIngestPath,
  scopeFromSegments,
} from "#src/ingest/route.js";

const validPaths: [string, string, boolean, string][] = [
  ["/api/1/envelope/", "default/default/default", false, "1"],
  ["/api/1/envelope", "default/default/default", false, "1"],
  ["/my-app/api/1/envelope/", "my-app/default/default", true, "1"],
  ["/my-app/3f9a1c/api/1/envelope/", "my-app/3f9a1c/default", true, "1"],
  ["/my-app/3f9a1c/web/api/1/envelope/", "my-app/3f9a1c/web", true, "1"],
  ["/my-app/_/web/api/1/envelope/", "my-app/default/web", true, "1"],
  ["/_/_/web/api/42/envelope/", "default/default/web", true, "42"],
  ["/api/api/1/envelope/", "api/default/default", true, "1"],
  ["/my.app/a-b_c/api/1/envelope/", "my.app/a-b_c/default", true, "1"],
];

const notIngestPaths = [
  "/",
  "/api/sentra/issues",
  "/mcp",
  "/my-app/api/x/envelope/",
  "/api/1/store/",
  "/my-app/api/1/envelope/extra",
];

const invalidScopePaths = [
  "/a/b/c/d/api/1/envelope/",
  `/${"a".repeat(65)}/api/1/envelope/`,
  "/my%20app/api/1/envelope/",
  "/a//b/api/1/envelope/",
  "/a b/api/1/envelope/",
  "//api/1/envelope/",
  "///api/1/envelope/",
];

describe("parseIngestPath", () => {
  it.each(validPaths)("valid paths: %s", (pathname, scope, hasScopeSegments, projectId) => {
    const [project, session, service] = scope.split("/");
    expect(parseIngestPath(pathname)).toEqual({
      scope: { project, session, service },
      projectId,
      hasScopeSegments,
    });
  });

  it.each(notIngestPaths)("returns null for %s", (pathname) => {
    expect(parseIngestPath(pathname)).toBeNull();
  });

  it.each(invalidScopePaths)("throws SentraScopeError for %s", (pathname) => {
    expect(() => parseIngestPath(pathname)).toThrow(SentraScopeError);
  });

  it("takes the pathname of the request URL, so the query string never reaches it", () => {
    const request = new Request(
      "http://localhost:8969/my-app/3f9a1c/web/api/1/envelope/?sentry_version=7&sentry_key=sentra",
    );
    const { pathname } = new URL(request.url);
    expect(parseIngestPath(pathname)?.scope).toEqual({
      project: "my-app",
      session: "3f9a1c",
      service: "web",
    });
  });
});

describe("isIngestPath", () => {
  it.each([...validPaths.map(([pathname]) => pathname), ...invalidScopePaths])(
    "is true for %s",
    (pathname) => {
      expect(isIngestPath(pathname)).toBe(true);
    },
  );

  it.each(notIngestPaths)("is false for %s", (pathname) => {
    expect(isIngestPath(pathname)).toBe(false);
  });
});

describe("scopeFromSegments", () => {
  it("fills missing segments with default", () => {
    expect(scopeFromSegments([])).toEqual({
      project: DEFAULT_SEGMENT,
      session: DEFAULT_SEGMENT,
      service: DEFAULT_SEGMENT,
    });
  });

  it.each([".", ".."])("rejects the dot segment %j with invalid_scope", (segment) => {
    expect(() => scopeFromSegments(["app", segment])).toThrow(
      expect.objectContaining({ code: "invalid_scope" }),
    );
  });

  it("names the offending segment", () => {
    expect(() => scopeFromSegments(["ok", "my app"])).toThrow('invalid scope segment "my app"');
  });

  it("rejects more than 3 segments with code invalid_scope", () => {
    expect(() => scopeFromSegments(["a", "b", "c", "d"])).toThrow(
      expect.objectContaining({ code: "invalid_scope" }),
    );
  });
});
