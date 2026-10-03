import { flattenAttributes } from "#src/normalize/attributes.js";

describe("flattenAttributes", () => {
  it("flattens the observed attribute types", () => {
    expect(
      flattenAttributes({
        "sentry.release": { value: "1.0.0", type: "string" },
        count: { value: 3, type: "integer" },
        ratio: { value: 0.5, type: "double" },
        ok: { value: false, type: "boolean" },
        future: { value: "x", type: "something-new" },
      }),
    ).toEqual({ "sentry.release": "1.0.0", count: 3, ratio: 0.5, ok: false, future: "x" });
  });

  it("drops entries without a primitive value", () => {
    expect(
      flattenAttributes({
        nested: { value: { a: 1 }, type: "object" },
        list: { value: [1], type: "array" },
        missing: { type: "string" },
        nil: { value: null, type: "string" },
        raw: "not typed",
        keep: { value: "", type: "string" },
      }),
    ).toEqual({ keep: "" });
  });

  it.each([[[{ value: 1 }]], [null], ["x"], [undefined]])("returns {} for %j", (input) => {
    expect(flattenAttributes(input)).toEqual({});
  });
});
