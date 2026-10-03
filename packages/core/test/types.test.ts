import type { EventData, Item, LogData } from "#src/index.js";
import { ITEM_KINDS, LEVELS } from "#src/index.js";

describe("types", () => {
  it("exports ordered levels and item kinds", () => {
    expect(LEVELS).toEqual(["trace", "debug", "info", "warning", "error", "fatal"]);
    expect(ITEM_KINDS).toEqual([
      "error",
      "message",
      "transaction",
      "span",
      "log",
      "attachment",
      "other",
    ]);
  });

  it("narrows Item by kind", () => {
    function dataOf(item: Item): unknown {
      if (item.kind === "error") {
        expectTypeOf(item.data).toEqualTypeOf<EventData>();
        return item.data;
      }
      if (item.kind === "message") {
        expectTypeOf(item.data).toEqualTypeOf<EventData>();
        return item.data;
      }
      if (item.kind === "log") {
        expectTypeOf(item.data).toEqualTypeOf<LogData>();
        return item.data;
      }
      return null;
    }
    expect(dataOf).toBeTypeOf("function");
  });
});
