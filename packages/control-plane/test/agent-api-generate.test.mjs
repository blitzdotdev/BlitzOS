import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ARTIFACT_PATH, generateAgentApiDocument } from "../scripts/generate-agent-api.mjs";

// The staleness half of the agent API conformance gate (plans/ORG-CREDENTIALS.md
// §4). The document GET /agent/api serves is a checked-in artifact; this test
// regenerates it from the schema types and the route manifest as they are now
// and demands the same bytes. A type edited without `npm run openapi:generate`
// fails here, in plain Node, because the generator needs the TypeScript
// compiler and a filesystem — neither of which the Workers pool has. The
// response half (each route's body against the document's schemas) is
// test/agent-api-conformance.test.ts.

test("packages/schema/openapi/agent-api.json is what the generator emits today", async () => {
  const committed = await readFile(ARTIFACT_PATH, "utf8");
  const regenerated = await generateAgentApiDocument();
  assert.equal(
    regenerated,
    committed,
    "the agent API document is stale: run `npm run openapi:generate` and commit the result",
  );
});

test("the generator is a pure function of its inputs", async () => {
  assert.equal(await generateAgentApiDocument(), await generateAgentApiDocument());
});
