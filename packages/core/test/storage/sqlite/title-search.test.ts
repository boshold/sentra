import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sqliteStorage } from "#src/storage/sqlite/index.js";
import type { ResolvedPage, StorageAdapter } from "#src/storage/types.js";

import { makeBatch } from "../../../../../test/storage-contract.js";
import { loadableSqliteDrivers } from "../../helpers/sqlite.js";

const drivers = await loadableSqliteDrivers();

const ALL: ResolvedPage = { limit: 500, cursor: null };
const TITLES = [
  "TypeError: boom",
  "50% done",
  "snake_case failed",
  "50x done",
  "snakeXcase failed",
];

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "sentra-search-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe.each(drivers)("sqlite title search with %s", (driverName) => {
  let storage: StorageAdapter;

  beforeEach(async () => {
    storage = sqliteStorage({ path: path.join(tempDir, "sentra.db"), driver: driverName });
    await storage.init();
    for (const [index, title] of TITLES.entries()) {
      const id = (index + 1).toString(16).padStart(16, "0");
      await storage.write(makeBatch({ items: [{ title, issueId: id, issue: { title } }] }));
    }
  });

  afterEach(async () => {
    await storage.close();
  });

  async function itemTitles(q: string): Promise<string[]> {
    const page = await storage.listItems({ q }, ALL);
    return page.items.map((item) => item.title).toSorted();
  }

  async function issueTitles(q: string): Promise<string[]> {
    const page = await storage.listIssues({ q }, ALL);
    return page.items.map((issue) => issue.title).toSorted();
  }

  it.each([
    ["boom", ["TypeError: boom"]],
    ["typeerror", ["TypeError: boom"]],
    ["%", ["50% done"]],
    ["_", ["snake_case failed"]],
    ["50%", ["50% done"]],
  ])("q %j matches literally in listItems and listIssues", async (q, expected) => {
    expect(await itemTitles(q)).toEqual(expected);
    expect(await issueTitles(q)).toEqual(expected);
  });

  it("deletes by q, treating % and _ literally", async () => {
    expect(await storage.deleteItems({ q: "%" })).toBe(1);
    expect(await storage.deleteItems({ q: "_" })).toBe(1);
    expect(await storage.deleteItems({ q: "boom" })).toBe(1);
    expect(await itemTitles("done")).toEqual(["50x done"]);
    expect(await itemTitles("failed")).toEqual(["snakeXcase failed"]);
  });
});
