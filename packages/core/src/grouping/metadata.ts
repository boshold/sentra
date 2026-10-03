import { resolveTitle } from "#src/grouping/fingerprint.js";
import type { Item, Level } from "#src/types.js";

interface IssueMetadata {
  title: string;
  culprit: string | null;
  level: Level;
  platform: string | null;
}

function defaultIssueLevel(kind: "error" | "message"): Level {
  return kind === "error" ? "error" : "info";
}

/** Issue fields taken from its latest event; `null` for records that never form issues. */
function issueMetadataOf(item: Item): IssueMetadata | null {
  if (item.kind !== "error" && item.kind !== "message") {
    return null;
  }
  return {
    title: resolveTitle(item.kind, item.data),
    culprit: item.data.culprit,
    level: item.level ?? defaultIssueLevel(item.kind),
    platform: item.platform,
  };
}

export { defaultIssueLevel, issueMetadataOf };
export type { IssueMetadata };
