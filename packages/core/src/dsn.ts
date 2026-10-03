import { SentraConfigError, SentraScopeError } from "#src/errors.js";
import { DEFAULT_SEGMENT, scopeFromSegments } from "#src/ingest/route.js";
import type { Scope } from "#src/types.js";

// The SDK requires a `\w+` public key and a numeric project id; both are ignored on ingest.
const PUBLIC_KEY = "sentra";
const PROJECT_ID = "1";
const PLACEHOLDER = "_";

function baseUrlProblem(url: URL): string | null {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `unsupported protocol ${url.protocol}`;
  }
  if (url.pathname !== "/") {
    return "must not contain a path";
  }
  if (url.search !== "" || url.hash !== "") {
    return "must not contain a query or hash";
  }
  if (url.username !== "" || url.password !== "") {
    return "must not contain credentials";
  }
  return null;
}

function parseBaseUrl(baseUrl: string): URL {
  const url = URL.parse(baseUrl);
  if (url === null) {
    throw new SentraConfigError("invalid_option", `invalid baseUrl ${JSON.stringify(baseUrl)}`);
  }
  const problem = baseUrlProblem(url);
  if (problem !== null) {
    throw new SentraConfigError(
      "invalid_option",
      `invalid baseUrl ${JSON.stringify(baseUrl)}: ${problem}`,
    );
  }
  return url;
}

/**
 * Builds `<protocol>//sentra@<host>/<project>/<session>/<service>/1`.
 * Trailing missing segments are omitted; missing middle segments become `_`.
 */
export function buildDsn(input: {
  baseUrl: string;
  project?: string;
  session?: string;
  service?: string;
}): string {
  const url = parseBaseUrl(input.baseUrl);
  const values = [input.project, input.session, input.service].map((value) =>
    value === undefined || value === DEFAULT_SEGMENT ? null : value,
  );
  const lastPresent = values.findLastIndex((value) => value !== null);
  const segments = values.slice(0, lastPresent + 1).map((value) => value ?? PLACEHOLDER);
  scopeFromSegments(segments);
  const path = [...segments, PROJECT_ID].join("/");
  return `${url.protocol}//${PUBLIC_KEY}@${url.host}/${path}`;
}

/** Inverse of `buildDsn`: reads the scope from the DSN path (last segment = project id). */
export function parseDsnScope(dsn: string): Scope {
  const url = URL.parse(dsn);
  if (url === null) {
    throw new SentraScopeError(`invalid DSN ${JSON.stringify(dsn)}`);
  }
  const segments = url.pathname.replace(/^\//, "").split("/").slice(0, -1);
  return scopeFromSegments(segments);
}
