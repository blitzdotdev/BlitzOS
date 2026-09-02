import agentApiDocument from "../../schema/openapi/agent-api.json";
import { boxCaller } from "./agent-routes.js";
import type { CoreRouter, RuntimeFactory } from "./runtime.js";

// packages/schema/openapi/agent-api.json is generated — never hand-written —
// by scripts/generate-agent-api.mjs from the schema package's types and the
// route manifest in core/agent-api-manifest.ts. Like the agent-rules skeleton
// it travels into the Worker bundle at build time, because a Worker has no
// filesystem to read it from: here as a JSON module, which every bundler on
// the way (wrangler's esbuild, the vitest Workers pool's Vite, tsc) resolves
// natively, so no `[[rules]]` block has to reach every deployment's config.
// The managed emitter inlines the same bytes (TEXT_ASSETS in
// scripts/lib/worker-source.mjs).
//
// A JSON module arrives parsed, so the bytes served are re-serialized once, at
// module load, with exactly the generator's formatting; the conformance test
// pins that round trip byte-for-byte against the artifact. Two more gates keep
// the file honest: test/agent-api-generate.test.mjs regenerates it and demands
// identical output, and test/agent-api-coverage.test.ts holds its paths equal
// to the router's. Edit the types or the manifest, run
// `npm run openapi:generate`, commit both.
export const AGENT_API_DOCUMENT: string = `${JSON.stringify(agentApiDocument, null, 2)}\n`;

/** `GET /agent/api`: the document, verbatim. Box-authed like every other
 * `/agent/*` route, so the reader is always a machine that can call what it
 * reads. */
export function addAgentApiRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
): void {
  router.get("/agent/api", async (context) => {
    await boxCaller(runtimeFactory(context), context.req.raw);
    return context.body(AGENT_API_DOCUMENT, 200, {
      "Content-Type": "application/json; charset=utf-8",
    });
  });
}
