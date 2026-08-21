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
  // oxlint reports the path as handed to it: bare "bad.ts" on some platforms,
  // a directory-qualified ".../bad.ts" on others. Accept both spellings.
  assert.ok(diagnostics.every(
    ({ filename }) => filename === "bad.ts" || filename.endsWith("/bad.ts"),
  ));
});
