import { buildDsn, parseDsnScope } from "#src/dsn.js";
import { SentraConfigError, SentraScopeError } from "#src/errors.js";
import { parseIngestPath } from "#src/ingest/route.js";

const BASE = "http://localhost:8969";

interface DsnInput {
  project?: string;
  session?: string;
  service?: string;
}

const buildCases: [string, DsnInput, string][] = [
  ["none", {}, "http://sentra@localhost:8969/1"],
  ["project", { project: "my-app" }, "http://sentra@localhost:8969/my-app/1"],
  [
    "project, session, service",
    { project: "my-app", session: "3f9a1c", service: "web" },
    "http://sentra@localhost:8969/my-app/3f9a1c/web/1",
  ],
  [
    "project, service",
    { project: "my-app", service: "web" },
    "http://sentra@localhost:8969/my-app/_/web/1",
  ],
  ["service", { service: "web" }, "http://sentra@localhost:8969/_/_/web/1"],
  ["session", { session: "s1" }, "http://sentra@localhost:8969/_/s1/1"],
  [
    "explicit defaults",
    { project: "default", session: "default", service: "web" },
    "http://sentra@localhost:8969/_/_/web/1",
  ],
];

function withDefaults(input: DsnInput): { project: string; session: string; service: string } {
  return {
    project: input.project ?? "default",
    session: input.session ?? "default",
    service: input.service ?? "default",
  };
}

describe("buildDsn", () => {
  it.each(buildCases)("%s", (_name, input, expected) => {
    expect(buildDsn({ baseUrl: BASE, ...input })).toBe(expected);
  });

  it.each([
    ["http://localhost:8969/", "http://sentra@localhost:8969/my-app/1"],
    ["https://sentra.example.com", "https://sentra@sentra.example.com/my-app/1"],
    ["http://[::1]:8969", "http://sentra@[::1]:8969/my-app/1"],
  ])("accepts baseUrl %s", (baseUrl, expected) => {
    expect(buildDsn({ baseUrl, project: "my-app" })).toBe(expected);
  });

  it("builds an IPv6 DSN without scope", () => {
    expect(buildDsn({ baseUrl: "http://[::1]:8969" })).toBe("http://sentra@[::1]:8969/1");
  });

  it.each([
    "not a url",
    "ftp://localhost:8969",
    "http://localhost:8969/sentra",
    "http://localhost:8969/?a=1",
    "http://localhost:8969/#x",
    "http://user:pass@localhost:8969",
  ])("throws invalid_option for baseUrl %s", (baseUrl) => {
    expect(() => buildDsn({ baseUrl })).toThrow(SentraConfigError);
    expect(() => buildDsn({ baseUrl })).toThrow(
      expect.objectContaining({ code: "invalid_option" }),
    );
  });

  it.each(["my app", "", "a".repeat(65), ".", ".."])(
    "throws SentraScopeError for segment %j",
    (project) => {
      expect(() => buildDsn({ baseUrl: BASE, project })).toThrow(SentraScopeError);
    },
  );

  it.each([{ session: ".." }, { session: "." }, { service: ".." }])(
    "rejects dot segments in any position: %j",
    (input) => {
      expect(() => buildDsn({ baseUrl: BASE, project: "app", ...input })).toThrow(SentraScopeError);
    },
  );

  it("still accepts segments containing dots", () => {
    expect(buildDsn({ baseUrl: BASE, project: "my.app", session: "...", service: ".x" })).toBe(
      `http://sentra@${new URL(BASE).host}/my.app/.../.x/1`,
    );
  });

  it.each(buildCases)("round trips through parseDsnScope: %s", (_name, input) => {
    expect(parseDsnScope(buildDsn({ baseUrl: BASE, ...input }))).toEqual(withDefaults(input));
  });

  it.each(buildCases)("round trips through the SDK ingest path: %s", (_name, input) => {
    const dsn = buildDsn({ baseUrl: BASE, ...input });
    const pathname = `${new URL(dsn).pathname.replace(/\/1$/, "")}/api/1/envelope/`;
    expect(parseIngestPath(pathname)?.scope).toEqual(withDefaults(input));
  });
});

describe("parseDsnScope", () => {
  it.each([
    ["http://sentra@localhost:8969/my-app/3f9a1c/web/1", "my-app/3f9a1c/web"],
    ["http://sentra@localhost:8969/my-app/_/web/1", "my-app/default/web"],
    ["http://sentra@localhost:8969/1", "default/default/default"],
    ["http://sentra@example.invalid:9000/my-app/web/1", "my-app/web/default"],
  ])("parses %s", (dsn, scope) => {
    const [project, session, service] = scope.split("/");
    expect(parseDsnScope(dsn)).toEqual({ project, session, service });
  });

  it.each([
    "http://sentra@localhost:8969/a/b/c/d/1",
    "http://sentra@localhost:8969/my%20app/1",
    "not a dsn",
  ])("throws SentraScopeError for %s", (dsn) => {
    expect(() => parseDsnScope(dsn)).toThrow(SentraScopeError);
  });
});
