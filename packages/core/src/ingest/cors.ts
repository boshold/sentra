const CORS_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "x-sentry-error, x-sentry-rate-limits, retry-after",
});

const PREFLIGHT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  ...CORS_HEADERS,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "content-type, content-encoding, x-sentry-auth, sentry-trace, baggage",
  "Access-Control-Max-Age": "86400",
});

const MAX_ERROR_HEADER_LENGTH = 200;

/** Header values must be printable ASCII; anything else becomes `?`. */
function sanitizeHeaderValue(value: string): string {
  return value.replaceAll(/[^ -~]/gu, "?").slice(0, MAX_ERROR_HEADER_LENGTH);
}

function preflightResponse(): Response {
  return new Response(null, { status: 204, headers: PREFLIGHT_HEADERS });
}

function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Response {
  return Response.json(body, {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", ...extraHeaders },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse(
    status,
    { error: { code, message } },
    { "X-Sentry-Error": sanitizeHeaderValue(message) },
  );
}

export { CORS_HEADERS, PREFLIGHT_HEADERS, errorResponse, jsonResponse, preflightResponse };
