import {
  SentraConfigError,
  SentraEncodingError,
  SentraError,
  SentraScopeError,
  SentraStorageError,
  SentraTooLargeError,
  SentraValidationError,
} from "#src/index.js";

const details = { field: "since" };
const cause = new Error("root cause");
const options = { details, cause };

const cases: { name: string; create: () => SentraError; code: string }[] = [
  { name: "SentraError", create: () => new SentraError("custom", "m", options), code: "custom" },
  {
    name: "SentraValidationError",
    create: () => new SentraValidationError("invalid_filter", "m", options),
    code: "invalid_filter",
  },
  {
    name: "SentraConfigError",
    create: () => new SentraConfigError("missing_public_url", "m", options),
    code: "missing_public_url",
  },
  {
    name: "SentraStorageError",
    create: () => new SentraStorageError("schema_too_new", "m", options),
    code: "schema_too_new",
  },
  {
    name: "SentraScopeError",
    create: () => new SentraScopeError("m", options),
    code: "invalid_scope",
  },
  {
    name: "SentraTooLargeError",
    create: () => new SentraTooLargeError("m", options),
    code: "payload_too_large",
  },
  {
    name: "SentraEncodingError",
    create: () => new SentraEncodingError("m", options),
    code: "unsupported_encoding",
  },
];

describe("error classes", () => {
  it.each(cases)("$name has code, name, details and cause", ({ name, create, code }) => {
    const error = create();
    expect(error).toBeInstanceOf(SentraError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe(name);
    expect(error.code).toBe(code);
    expect(error.message).toBe("m");
    expect(error.details).toBe(details);
    expect(error.cause).toBe(cause);
  });

  it("omits details and cause when not given", () => {
    const error = new SentraScopeError("x");
    expect(error.code).toBe("invalid_scope");
    expect(error.name).toBe("SentraScopeError");
    expect(error.details).toBeUndefined();
    expect("cause" in error).toBe(false);
  });
});
