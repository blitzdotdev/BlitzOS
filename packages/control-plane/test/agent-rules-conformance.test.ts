import { beforeEach, describe, expect, it } from "vitest";
import { AGENT_RULE_CONTENT_MAX_BYTES, AGENT_RULES_DOC, contentVersion } from "../core/agent-rules.js";
import type { AgentRulesResponse } from "../core/wire.js";
import { appRequest, enrollBox, harness, operatorSession, resetDatabase } from "./helpers.js";

// Producer side of the `agent-rules` cross-runtime contract. The box consumer
// (`blitz-rules sync`) is pinned against the same fixtures in
// packages/box/actor/test/agent-rules-conformance.test.ts.
interface AgentRulesFixture {
  response: object;
  accepts: boolean;
}

const fixtureSources = import.meta.glob<string>(
  "../../schema/fixtures/agent-rules/*.json",
  { eager: true, import: "default", query: "?raw" },
);

/** limits.json is the shared size definition, not an envelope fixture. */
const LIMITS_FIXTURE = "limits.json";

function sharedMaxContentBytes(): number {
  const source = Object.entries(fixtureSources)
    .find(([path]) => path.endsWith(LIMITS_FIXTURE))?.[1];
  if (source === undefined) throw new Error("agent-rules limits fixture was not inlined");
  // SAFETY: Trusted local test data authored to the { maxContentBytes } shape.
  return (JSON.parse(source) as { maxContentBytes: number }).maxContentBytes;
}

function fixtures(): Array<[string, AgentRulesFixture]> {
  return Object.entries(fixtureSources)
    .filter(([path]) => !path.endsWith(LIMITS_FIXTURE))
    .map(([path, source]): [string, AgentRulesFixture] => {
      // SAFETY: The agent-rules fixtures are trusted local test data authored
      // to the { response, accepts } shape; the box consumer test pins the same
      // corpus.
      const fixture = JSON.parse(source) as AgentRulesFixture;
      return [path.slice(path.lastIndexOf("/") + 1), fixture];
    })
    .sort(([left], [right]) => left.localeCompare(right));
}

describe("agent-rules control-plane endpoint", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("pins the shared agent-rules fixture corpus", () => {
    expect(fixtures().map(([name]) => name)).toEqual([
      "empty-content.json",
      "missing-content.json",
      "missing-version.json",
      "non-string-version.json",
      "valid-minimal.json",
    ]);
  });

  // The box refuses to install a document larger than this, measured the same
  // way — UTF-8 bytes of `content` after parsing. One number, one quantity, two
  // runtimes; anything else lets this route store a rule no box can apply.
  it("enforces the shared content byte cap", () => {
    expect(AGENT_RULE_CONTENT_MAX_BYTES).toBe(sharedMaxContentBytes());
  });

  it("returns the versioned envelope to an authenticated box", async () => {
    const { app } = harness();
    const cookie = await operatorSession();
    const credential = await enrollBox(app, cookie);

    const response = await appRequest(app, "/workspaces/self/agent-rules", {
      headers: { Authorization: `Bearer ${credential.access_token}` },
    });

    expect(response.status).toBe(200);
    const body = await response.json<AgentRulesResponse>();
    expect(body).toEqual({ version: contentVersion(AGENT_RULES_DOC), content: AGENT_RULES_DOC });
    expect(body.version).toMatch(/^[0-9a-f]{16}$/u);
    // The emitted envelope keys are exactly the ones the accepted fixture (and
    // therefore the box consumer) expects.
    const accepted = fixtures().find(([, fixture]) => fixture.accepts)?.[1];
    if (accepted === undefined) throw new Error("no accepted agent-rules fixture");
    expect(Object.keys(body).sort()).toEqual(Object.keys(accepted.response).sort());
  });

  it("rejects an unauthenticated or bad-token read with 401", async () => {
    const { app } = harness();

    const anonymous = await appRequest(app, "/workspaces/self/agent-rules");
    const badToken = await appRequest(app, "/workspaces/self/agent-rules", {
      headers: { Authorization: "Bearer not-a-real-box-token" },
    });

    expect(anonymous.status).toBe(401);
    expect(badToken.status).toBe(401);
  });
});
