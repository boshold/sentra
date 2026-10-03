import {
  CORS_HEADERS,
  PREFLIGHT_HEADERS,
  errorResponse,
  jsonResponse,
  preflightResponse,
} from "#src/ingest/cors.js";

describe("cors", () => {
  it("defines the CORS headers", () => {
    expect(CORS_HEADERS).toEqual({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "x-sentry-error, x-sentry-rate-limits, retry-after",
    });
    expect(PREFLIGHT_HEADERS).toMatchObject(CORS_HEADERS);
  });

  it("builds a 204 preflight", async () => {
    const response = preflightResponse();
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    expect(response.headers.get("access-control-max-age")).toBe("86400");
  });

  it("builds a JSON response with CORS and extra headers", async () => {
    const response = jsonResponse(200, { id: "x" }, { "X-Extra": "1" });
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("x-extra")).toBe("1");
    expect(await response.json()).toEqual({ id: "x" });
  });

  it("builds an error response with a sanitized X-Sentry-Error header", async () => {
    const message = `bad “quote” ${"x".repeat(300)}`;
    const response = errorResponse(400, "invalid_scope", message);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_scope", message } });
    const header = response.headers.get("x-sentry-error") ?? "";
    expect(header).toHaveLength(200);
    expect(header.startsWith("bad ?quote? x")).toBe(true);
    expect(/^[ -~]*$/u.test(header)).toBe(true);
  });
});
