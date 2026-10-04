import { renderIssueDetail, renderIssueLine } from "#src/index.js";

import { NOW, errorItem, issue } from "./factories.js";

describe("renderIssueLine", () => {
  it("renders one line", () => {
    expect(renderIssueLine(issue(), NOW)).toBe(
      "7c2f91ab error 3× 5m ago [web,api] TypeError: boom",
    );
    expect(
      renderIssueLine(issue({ title: "a\nb", culprit: "loadUser(Card.vue)", services: [] }), NOW),
    ).toBe("7c2f91ab error 3× 5m ago [] a - loadUser(Card.vue)");
  });
});

describe("renderIssueDetail", () => {
  it("renders the issue with the latest event", () => {
    const latest = errorItem(
      {},
      { level: "error", issueId: "7c2f91ab-0000-7000-8000-000000000000" },
    );
    expect(renderIssueDetail({ ...issue({ culprit: "loadUser" }), latest }, NOW))
      .toMatchInlineSnapshot(`
      "# TypeError: boom

      id: 7c2f91ab-0000-7000-8000-000000000000
      shortId: 7c2f91ab
      level: error
      count: 3
      first seen: 2026-10-01T12:00:00.000Z (2d ago)
      last seen: 2026-10-03T11:55:00.000Z (5m ago)
      services: web, api
      culprit: loadUser

      ## Latest event
      id: 01JITEM000000000000000000
      kind: error
      level: error
      scope: my-app/3f9a1c/web
      timestamp: 2026-10-03T11:59:00.000Z
      issue: 7c2f91ab-0000-7000-8000-000000000000

      ## Source maps
      status: not_applicable
      mapped: 0/0"
    `);
  });

  it("indents multi-line culprits", () => {
    const text = renderIssueDetail(
      { ...issue({ culprit: "a\n## Latest event" }), latest: null },
      NOW,
    );
    expect(text).toContain("culprit: a\n    ## Latest event\n\n## Latest event\nNot stored.");
    expect(text.match(/^## /gm)).toHaveLength(1);
    expect(renderIssueLine(issue({ services: ["a\nb"], culprit: "x\ny" }), NOW)).not.toContain(
      "\n",
    );
  });

  it("handles a pruned latest event", () => {
    const text = renderIssueDetail({ ...issue({ title: "\u001b[31mred" }), latest: null }, NOW);
    expect(text).toContain("## Latest event\nNot stored.");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("culprit");
  });
});
