import { SentraValidationError } from "@boshold/sentra-core";

import { parseFilterParams } from "#src/api.js";

const ITEM = [
  "project",
  "kind",
  "level",
  "since",
  "from",
  "to",
  "q",
  "limit",
  "cursor",
  "minLevel",
  "eventId",
];

function parse(
  query: string,
  allowed: readonly string[] = ITEM,
): ReturnType<typeof parseFilterParams> {
  return parseFilterParams(new URLSearchParams(query), allowed);
}

function failure(query: string, allowed: readonly string[] = ITEM): unknown {
  try {
    parse(query, allowed);
  } catch (error) {
    return error;
  }
  throw new Error(`expected ${query} to fail`);
}

describe("parseFilterParams", () => {
  it.each([
    ["", { filter: {}, page: {} }],
    ["kind=error", { filter: { kind: ["error"] }, page: {} }],
    ["kind=error,message&kind=log", { filter: { kind: ["error", "message", "log"] }, page: {} }],
    ["kind=,error,,&kind=", { filter: { kind: ["error"] }, page: {} }],
    ["kind=", { filter: {}, page: {} }],
    ["project=a%2Cb", { filter: { project: ["a", "b"] }, page: {} }],
    ["since=60m&q=a,b", { filter: { since: "60m", q: "a,b" }, page: {} }],
    [
      "from=1700000000000&to=2026-10-03T00:00:00Z",
      { filter: { from: 1_700_000_000_000, to: "2026-10-03T00:00:00Z" }, page: {} },
    ],
    ["from=-1", { filter: { from: "-1" }, page: {} }],
    ["limit=5&cursor=abc", { filter: {}, page: { limit: 5, cursor: "abc" } }],
    ["minLevel=warning", { filter: { minLevel: "warning" }, page: {} }],
    ["q=&since=%20&eventId=-&cursor=", { filter: {}, page: {} }],
    ["eventId=ab-cd", { filter: { eventId: "ab-cd" }, page: {} }],
  ])("%s", (query, expected) => {
    expect(parse(query)).toEqual(expected);
  });

  it.each([["limit=abc"], ["limit=1.5"], ["limit=-1"], ["limit="], ["since=1m&since=2m"]])(
    "rejects %s",
    (query) => {
      expect(failure(query)).toBeInstanceOf(SentraValidationError);
      expect(failure(query)).toMatchObject({ code: "invalid_filter" });
    },
  );

  it("lists unknown parameters", () => {
    expect(failure("foo=1&bar=2&kind=log")).toMatchObject({
      code: "invalid_filter",
      details: { unknown: ["foo", "bar"] },
    });
    expect(failure("limit=1", ["project"])).toMatchObject({ details: { unknown: ["limit"] } });
  });
});
