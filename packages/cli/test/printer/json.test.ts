import { formatLiveEventJson } from "#src/printer/json.js";

import { fixtureEvents } from "./events.js";

describe("formatLiveEventJson", () => {
  it("round-trips live events on one line", async () => {
    const events = await fixtureEvents(["node-error", "node-logs", "node-spans"]);
    expect(events.length).toBeGreaterThan(2);
    for (const event of events) {
      const line = formatLiveEventJson(event);
      expect(line).not.toContain("\n");
      expect(JSON.parse(line)).toEqual(event);
    }
  });
});
