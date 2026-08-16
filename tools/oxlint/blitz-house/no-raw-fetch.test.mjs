import assert from "node:assert/strict";
import test from "node:test";

import { runRule } from "./test-helpers.mjs";

test("no-raw-fetch flags direct global fetch calls and honors exact allowed files", () => {
  const diagnostics = runRule(
    "no-raw-fetch",
    {
      "bad.ts": [
        'fetch("/one");',
        'globalThis.fetch("/two");',
        'self["fetch"]("/three");',
        'window.fetch("/four");',
      ].join("\n"),
      "allowed.ts": 'fetch("/allowed");\n',
      "good.ts": [
        "const fetcher = fetch;",
        "void fetcher;",
        "function localFetchScope(fetch) { fetch(\"/injected\"); }",
        "void localFetchScope;",
      ].join("\n"),
    },
    ["allowed.ts"],
  );

  assert.equal(diagnostics.length, 4);
  assert.ok(diagnostics.every(({ filename }) => filename.endsWith("/bad.ts")));
});
