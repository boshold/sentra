import { randomUUID } from "node:crypto";

interface EventPayload {
  platform: string;
  frames: Record<string, unknown>[];
}

/** One `event` item with a single exception; scope `e2e/s1/web`. */
function eventEnvelope({ platform, frames }: EventPayload): { eventId: string; request: Request } {
  const eventId = randomUUID().replaceAll("-", "");
  const event = {
    event_id: eventId,
    platform,
    exception: { values: [{ type: "Error", value: "boom", stacktrace: { frames } }] },
  };
  const body = [
    JSON.stringify({ event_id: eventId }),
    JSON.stringify({ type: "event" }),
    JSON.stringify(event),
  ].join("\n");
  return {
    eventId,
    request: new Request("http://localhost/e2e/s1/web/api/1/envelope/", { method: "POST", body }),
  };
}

export { eventEnvelope };
export type { EventPayload };
