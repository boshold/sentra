import { readFileSync } from "node:fs";

import { ZodObject } from "zod";

import type { Sentra } from "#src/index.js";
import { createMcpTools } from "#src/mcp/tools.js";
import type { McpToolDeps } from "#src/mcp/tools.js";
import type { Issue, IssueFilter, ItemFilter, ItemSummary, SpanItem } from "#src/types.js";

import {
  NOW,
  errorItem,
  frame,
  issue,
  libraryFrame,
  mapped,
  spanItem,
} from "../render/factories.js";

import { seededSentra, textOf, toolByName } from "./helpers.js";

const NAMES = [
  "sentra_list_scopes",
  "sentra_list_issues",
  "sentra_get_issue",
  "sentra_list_items",
  "sentra_get_item",
];

let sentra: Sentra;
let issues: Issue[];

beforeAll(async () => {
  sentra = await seededSentra();
  const page = await sentra.query.listIssues({ since: "24h" });
  issues = page.items;
});

afterAll(async () => {
  await sentra.close();
});

async function call(name: string, input: unknown): Promise<{ text: string; isError: boolean }> {
  const result = await toolByName(sentra.mcpTools(), name).handler(input);
  return { text: textOf(result), isError: result.isError === true };
}

describe("tool definitions", () => {
  it("returns five read-only tools in order", () => {
    const tools = sentra.mcpTools();
    expect(tools.map((tool) => tool.name)).toEqual(NAMES);
    for (const tool of tools) {
      expect(tool.title).not.toBe("");
      expect(tool.description).toContain("Example: ");
      expect(tool.inputSchema).toBeInstanceOf(ZodObject);
      expect(tool.annotations).toEqual({ readOnlyHint: true });
      for (const field of Object.values(tool.inputSchema.shape)) {
        expect(field.description).toEqual(expect.any(String));
      }
    }
  });

  it("keeps MCP SDKs out of runtime dependencies", () => {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    const dependencies =
      typeof manifest === "object" && manifest !== null
        ? Reflect.get(manifest, "dependencies")
        : null;
    expect(
      Object.keys(dependencies ?? {}).filter((name) => name.includes("modelcontextprotocol")),
    ).toEqual([]);
  });

  it("never throws on bad input", async () => {
    for (const tool of sentra.mcpTools()) {
      for (const input of [undefined, null, "text", 1, { limit: "x", id: 5 }]) {
        const result = await tool.handler(input);
        if (result.isError === true) {
          expect(textOf(result)).not.toBe("");
        }
      }
    }
  });
});

describe("sentra_list_scopes", () => {
  it("renders the scope table", async () => {
    const result = await call("sentra_list_scopes", {});
    expect(result.text).toContain("| my-app/3f9a1c/web |");
    const empty = await call("sentra_list_scopes", { project: "nope" });
    expect(empty.text).toBe("No scopes.");
  });
});

describe("sentra_list_issues", () => {
  it("lists issues of the last 24h, one line each", async () => {
    expect(issues.length).toBeGreaterThanOrEqual(2);
    const result = await call("sentra_list_issues", undefined);
    const lines = result.text.split("\n");
    expect(lines).toHaveLength(issues.length);
    for (const line of lines) {
      expect(line).toMatch(/^[0-9a-f]{8} \w+ \d+× \d+[smhd] ago \[/);
    }
  });

  it("rejects limit 101", async () => {
    const result = await call("sentra_list_issues", { limit: 101 });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("limit");
  });

  it("paginates with nextCursor", async () => {
    const first = await call("sentra_list_issues", { limit: 1 });
    const cursor = /^nextCursor: (?<cursor>\S+)$/m.exec(first.text)?.groups?.cursor;
    expect(cursor).toEqual(expect.any(String));
    const second = await call("sentra_list_issues", { limit: 1, cursor });
    expect(second.text.split("\n")[0]).toMatch(new RegExp(`^${issues[1]?.shortId ?? "missing"} `));
    const invalid = await call("sentra_list_issues", { cursor: "garbage" });
    expect(invalid.isError).toBe(true);
  });

  it("returns No issues. for an empty result", async () => {
    const empty = await call("sentra_list_issues", { project: "nope" });
    expect(empty.text).toBe("No issues.");
  });
});

describe("sentra_get_issue", () => {
  it("resolves full ids and short ids", async () => {
    const [target] = issues;
    if (target === undefined) {
      throw new Error("no issue");
    }
    for (const id of [target.id, target.shortId, target.shortId.toUpperCase()]) {
      const result = await call("sentra_get_issue", { id });
      expect(result.isError).toBe(false);
      expect(result.text).toContain(`id: ${target.id}`);
      expect(result.text).toContain("## Latest event");
    }
  });

  it("rejects short and unknown ids", async () => {
    const tooShort = await call("sentra_get_issue", { id: "abcdef1" });
    expect(tooShort.isError).toBe(true);
    for (const id of ["ffffffffffffffff", "ffffffff"]) {
      expect(await call("sentra_get_issue", { id })).toEqual({
        isError: true,
        text: `Issue not found: ${id}`,
      });
    }
  });

  it("reports ambiguous prefixes", async () => {
    const findIssues = vi.fn<McpToolDeps["findIssues"]>(async () => [
      issue(),
      issue({ id: "7c2f91ab00000001" }),
    ]);
    const tools = createMcpTools({ query: sentra.query, findIssues });
    const result = await toolByName(tools, "sentra_get_issue").handler({
      id: "7c2f91ab",
      project: "my-app",
    });
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "Ambiguous issue id 7c2f91ab; pass project and session or the full id",
        },
      ],
    });
    expect(findIssues).toHaveBeenCalledWith("7c2f91ab", { project: "my-app" });
  });
});

describe("sentra_list_items", () => {
  it("lists records and rejects since with from", async () => {
    const result = await call("sentra_list_items", { from: 0, kind: "log" });
    expect(
      result.text
        .split("\n")
        .every((line) => / log \w+ my-app\/3f9a1c\/web .+ \[[\w-]+\]$/.test(line)),
    ).toBe(true);
    const invalid = await call("sentra_list_items", { since: "60m", from: "2026-01-01T00:00:00Z" });
    expect(invalid.isError).toBe(true);
    const empty = await call("sentra_list_items", { project: "nope", from: 0 });
    expect(empty.text).toBe("No items.");
  });

  it("applies default since and limit", async () => {
    const listItems = vi.fn<Sentra["query"]["listItems"]>(async () => ({
      items: [],
      nextCursor: null,
    }));
    const listIssues = vi.fn<Sentra["query"]["listIssues"]>(async () => ({
      items: [issue()],
      nextCursor: "c1",
    }));
    const tools = createMcpTools({
      query: { ...sentra.query, listItems, listIssues },
      findIssues: async () => [],
      now: () => NOW,
    });
    await toolByName(tools, "sentra_list_items").handler({});
    await toolByName(tools, "sentra_list_items").handler({ from: 5, limit: 3, cursor: "x" });
    await toolByName(tools, "sentra_list_items").handler({ since: "2h" });
    const issueResult = await toolByName(tools, "sentra_list_issues").handler({
      project: "my-app",
    });
    const filters: (ItemFilter | undefined)[] = listItems.mock.calls.map(([filter]) => filter);
    expect(filters).toEqual([{ since: "60m" }, { from: 5 }, { since: "2h" }]);
    expect(listItems.mock.calls.map(([, page]) => page)).toEqual([
      { limit: 20, cursor: undefined },
      { limit: 3, cursor: "x" },
      { limit: 20, cursor: undefined },
    ]);
    const issueFilter: IssueFilter | undefined = listIssues.mock.calls[0]?.[0];
    expect(issueFilter).toEqual({ project: "my-app", since: "24h" });
    expect(textOf(issueResult)).toBe(
      "7c2f91ab error 3× 5m ago [web,api] TypeError: boom\n\nnextCursor: c1",
    );
  });
});

describe("sentra_get_item", () => {
  it("finds an item by id and by event id", async () => {
    const page = await sentra.query.listItems({ kind: "error", from: 0 });
    const [summary] = page.items;
    if (summary === undefined || summary.eventId === null) {
      throw new Error("no error item");
    }
    const byId = await call("sentra_get_item", { id: summary.id });
    const byEventId = await call("sentra_get_item", { id: summary.eventId });
    expect(byId.isError).toBe(false);
    expect(byEventId).toEqual(byId);
    expect(byId.text).toMatch(/^at .+:\d+:\d+\)$/m);
    expect(await call("sentra_get_item", { id: "nope" })).toEqual({
      isError: true,
      text: "Item not found: nope",
    });
  });

  it("renders mapped frames and breadcrumbs", async () => {
    const item = errorItem({
      exceptions: [
        {
          type: "TypeError",
          value: "boom",
          module: null,
          mechanism: null,
          frames: [libraryFrame(), frame({ function: "loadUser", mapped: mapped() })],
        },
      ],
      breadcrumbs: [
        {
          timestamp: "2026-10-03T11:58:00.000Z",
          type: null,
          category: "ui.click",
          level: "info",
          message: "button",
          data: null,
        },
      ],
    });
    const tools = createMcpTools({
      query: { ...sentra.query, getItem: async () => item },
      findIssues: async () => [],
    });
    const text = textOf(await toolByName(tools, "sentra_get_item").handler({ id: item.id }));
    expect(text).toContain("at loadUser (components/User/Profile/Card.vue:42:13)");
    expect(text).toContain("## Breadcrumbs\n2026-10-03T11:58:00.000Z ui.click info button");
  });

  it("adds the spans of the same trace", async () => {
    const page = await sentra.query.listItems({ kind: "span", from: 0 });
    const [span] = page.items;
    if (span === undefined) {
      throw new Error("no span item");
    }
    const result = await call("sentra_get_item", { id: span.id });
    expect(result.text).toContain("## Trace spans");
    for (const other of page.items) {
      expect(result.text).toContain(`[${other.id}]`);
    }
  });

  describe("trace spans", () => {
    function traceOf(durations: number[]): SpanItem[] {
      return durations.map((durationMs, index) => ({
        ...spanItem(durationMs),
        id: `span-${String(index).padStart(5, "0")}`,
        traceId: "trace-1",
      }));
    }

    /** Newest (highest id) first, like storage. */
    function toolsFor(spans: SpanItem[]) {
      const byId = new Map(spans.map((span) => [span.id, span]));
      const newestFirst = spans.toSorted((a, b) => b.id.localeCompare(a.id));
      const listItems = vi.fn<Sentra["query"]["listItems"]>(async (_filter, page) => {
        const start = page?.cursor === undefined ? 0 : Number(page.cursor);
        const limit = page?.limit ?? 20;
        const items: ItemSummary[] = newestFirst.slice(start, start + limit);
        const next = start + limit;
        return { items, nextCursor: next < newestFirst.length ? String(next) : null };
      });
      const tools = createMcpTools({
        query: { ...sentra.query, listItems, getItem: async (id) => byId.get(id) ?? null },
        findIssues: async () => [],
      });
      return { tools, listItems };
    }

    it("picks the longest spans from the whole trace and reports the true total", async () => {
      const spans = traceOf([10_000, ...Array.from({ length: 100 }, () => 1)]);
      const { tools } = toolsFor(spans);
      const newest = spans.at(-1);
      const text = textOf(
        await toolByName(tools, "sentra_get_item").handler({ id: newest?.id ?? "" }),
      );
      expect(text).toContain("[span-00000]");
      expect(text).toContain("(20 of 101 spans)");
    });

    it("pages through traces larger than one page", async () => {
      const durations = Array.from({ length: 1201 }, (_, index) => (index === 3 ? 500 : 1));
      const spans = traceOf(durations);
      const { tools, listItems } = toolsFor(spans);
      const text = textOf(await toolByName(tools, "sentra_get_item").handler({ id: "span-00003" }));
      expect(listItems).toHaveBeenCalledTimes(3);
      expect(text).toMatch(/## Trace spans\n\S+ db span 500 \[span-00003\]/);
      expect(text).toContain("(20 of 1201 spans)");
    });
  });
});
