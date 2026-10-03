import { SentraScopeError } from "#src/errors.js";
import type { Scope } from "#src/types.js";

const DEFAULT_SEGMENT = "default";
const SEGMENT_RE = /^[A-Za-z0-9._-]{1,64}$/;
const INGEST_SUFFIX_RE = /(?:^|\/)api\/(?<projectId>\d+)\/envelope\/?$/;
const MAX_SEGMENTS = 3;

function normalizeSegment(segment: string | undefined): string {
  if (segment === undefined || segment === "_") {
    return DEFAULT_SEGMENT;
  }
  if (!SEGMENT_RE.test(segment)) {
    throw new SentraScopeError(`invalid scope segment ${JSON.stringify(segment)}`, {
      details: { segment },
    });
  }
  return segment;
}

/** Whether `value` is a valid scope segment (`[A-Za-z0-9._-]{1,64}`). */
export function isScopeSegment(value: string): boolean {
  return SEGMENT_RE.test(value);
}

/** Maps up to 3 path segments to a scope; `_` and missing segments become `default`. */
export function scopeFromSegments(segments: readonly string[]): Scope {
  if (segments.length > MAX_SEGMENTS) {
    throw new SentraScopeError(
      `too many scope segments (${segments.length}, max ${MAX_SEGMENTS}): ${segments.join("/")}`,
      { details: { segments } },
    );
  }
  for (const segment of segments) {
    normalizeSegment(segment);
  }
  const [project, session, service] = segments;
  return {
    project: normalizeSegment(project),
    session: normalizeSegment(session),
    service: normalizeSegment(service),
  };
}

/** Whether the pathname ends in `/api/<digits>/envelope[/]`. Scope segments are not validated. */
export function isIngestPath(pathname: string): boolean {
  return INGEST_SUFFIX_RE.test(pathname);
}

/**
 * Parses a request pathname (never the full URL: pass `new URL(request.url).pathname`).
 * Returns `null` when it is not an ingest path; throws `SentraScopeError` for an invalid scope.
 */
export function parseIngestPath(
  pathname: string,
): { scope: Scope; projectId: string; hasScopeSegments: boolean } | null {
  const match = INGEST_SUFFIX_RE.exec(pathname);
  const projectId = match?.groups?.projectId;
  if (match === null || projectId === undefined) {
    return null;
  }
  // Keep empty segments (`//api/...`) so they fail validation instead of vanishing.
  const prefix = pathname.slice(0, match.index);
  const segments = prefix === "" ? [] : prefix.replace(/^\//, "").split("/");
  return {
    scope: scopeFromSegments(segments),
    projectId,
    hasScopeSegments: segments.length > 0,
  };
}

export { DEFAULT_SEGMENT };
