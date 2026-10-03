import type { Sentra } from "#src/index.js";

/** One valid call per tool against the seeded instance. */
async function toolCalls(
  sentra: Sentra,
): Promise<{ name: string; arguments: Record<string, unknown> }[]> {
  const issuePage = await sentra.query.listIssues({ since: "24h" });
  const itemPage = await sentra.query.listItems({ kind: "error", from: 0 });
  const [issue] = issuePage.items;
  const [item] = itemPage.items;
  if (issue === undefined || item === undefined) {
    throw new Error("seed data missing");
  }
  return [
    { name: "sentra_list_scopes", arguments: {} },
    { name: "sentra_list_issues", arguments: { limit: 5 } },
    { name: "sentra_get_issue", arguments: { id: issue.shortId } },
    { name: "sentra_list_items", arguments: { from: 0, kind: ["error", "log"] } },
    { name: "sentra_get_item", arguments: { id: item.id } },
  ];
}

export { toolCalls };
