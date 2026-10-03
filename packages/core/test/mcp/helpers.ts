import { createSentra, memoryStorage } from "#src/index.js";
import type { Sentra } from "#src/index.js";
import type { SentraToolDefinition } from "#src/types.js";

import { fixtureToRequest, loadEnvelopeFixture } from "../../../../test/fixtures/envelopes.js";

const FIXTURES = ["node-error", "browser-error", "node-message", "node-spans", "node-logs"];

async function seededSentra(): Promise<Sentra> {
  const sentra = await createSentra({ storage: memoryStorage() });
  for (const name of FIXTURES) {
    await sentra.handle(fixtureToRequest(loadEnvelopeFixture(name)));
  }
  return sentra;
}

function toolByName(tools: SentraToolDefinition[], name: string): SentraToolDefinition {
  const found = tools.find((tool) => tool.name === name);
  if (found === undefined) {
    throw new Error(`missing tool ${name}`);
  }
  return found;
}

function textOf(result: { content: { type: "text"; text: string }[] }): string {
  return result.content.map((part) => part.text).join("\n");
}

export { seededSentra, textOf, toolByName };
