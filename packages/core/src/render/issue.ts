import { formatRelativeTime, renderItemDetail } from "#src/render/item.js";
import type { Issue, IssueDetail } from "#src/types.js";
import { firstLine, sanitizeText } from "#src/util/text.js";

function renderIssueLine(issue: Issue, now: Date): string {
  const line = [
    issue.shortId,
    issue.level,
    `${issue.count}×`,
    formatRelativeTime(issue.lastSeenAt, now),
    `[${issue.services.join(",")}]`,
    firstLine(issue.title),
  ].join(" ");
  return issue.culprit === null ? line : `${line} — ${firstLine(issue.culprit)}`;
}

function renderIssueDetail(detail: IssueDetail, now: Date): string {
  const lines = [
    `# ${firstLine(detail.title)}`,
    "",
    `id: ${detail.id}`,
    `shortId: ${detail.shortId}`,
    `level: ${detail.level}`,
    `count: ${detail.count}`,
    `first seen: ${detail.firstSeenAt} (${formatRelativeTime(detail.firstSeenAt, now)})`,
    `last seen: ${detail.lastSeenAt} (${formatRelativeTime(detail.lastSeenAt, now)})`,
    `services: ${detail.services.join(", ")}`,
    ...(detail.culprit === null ? [] : [`culprit: ${detail.culprit}`]),
    "",
    "## Latest event",
    detail.latest === null ? "Not stored." : renderItemDetail(detail.latest),
  ];
  return sanitizeText(lines.join("\n"));
}

export { renderIssueDetail, renderIssueLine };
