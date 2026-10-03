import type { Item, ItemFilter, ItemSummary, Sentra } from "@boshold/sentra-core";

import { runScenario } from "./scenario.js";
import type { RecordedRequest } from "./server.js";

/** Runs a scenario file and expects exit code 0 and no stderr output. */
async function runOk(file: string, env: Record<string, string>): Promise<void> {
  const result = await runScenario(file, env);
  // Node runtime warnings and their --trace-warnings hint are not failures.
  const stderr = result.stderr
    .split("\n")
    .filter((line) => line !== "" && !/^\((?:node:|Use `node --trace-)/.test(line));
  expect(stderr).toEqual([]);
  expect(result.code).toBe(0);
}

async function listAll(sentra: Sentra, filter: ItemFilter = {}): Promise<ItemSummary[]> {
  const page = await sentra.query.listItems(filter, { limit: 500 });
  expect(page.nextCursor).toBeNull();
  return page.items;
}

async function getFull(sentra: Sentra, summary: ItemSummary | undefined): Promise<Item> {
  expect(summary).toBeDefined();
  const item = summary === undefined ? null : await sentra.query.getItem(summary.id);
  if (item === null) {
    throw new Error("expected a stored record");
  }
  return item;
}

function isKind<K extends Item["kind"]>(item: Item, kind: K): item is Extract<Item, { kind: K }> {
  return item.kind === kind;
}

function narrow<K extends Item["kind"]>(item: Item, kind: K): Extract<Item, { kind: K }> {
  if (!isKind(item, kind)) {
    throw new Error(`expected a ${kind} record, got ${item.kind}`);
  }
  return item;
}

async function findOne<K extends Item["kind"]>(
  sentra: Sentra,
  kind: K,
  title: string,
): Promise<Extract<Item, { kind: K }>> {
  const all = await listAll(sentra, { kind });
  const matches = all.filter((item) => item.title === title);
  expect(matches).toHaveLength(1);
  return narrow(await getFull(sentra, matches[0]), kind);
}

function posts(requests: RecordedRequest[]): RecordedRequest[] {
  return requests.filter((request) => request.method === "POST");
}

export { findOne, getFull, isKind, listAll, narrow, posts, runOk };
