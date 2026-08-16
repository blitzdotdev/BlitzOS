import assert from "node:assert/strict";
import test from "node:test";

import { runRule } from "./test-helpers.mjs";

test("no-console-in-core flags console members and honors exact allowed files", () => {
  const diagnostics = runRule(
    "no-console-in-core",
    {
      "bad.ts": [
        'console.log("one");',
        'console["warn"]("two");',
        "const report = console.error;",
        'globalThis.console.info("three");',
        "void report;",
      ].join("\n"),
      "allowed.ts": 'console.error("allowed");\n',
      "good.ts": [
        'logger.info("structured");',
        "function localConsoleScope(console) { console.log(\"local\"); }",
        "void localConsoleScope;",
      ].join("\n"),
    },
    ["allowed.ts"],
  );

  assert.equal(diagnostics.length, 4);
  assert.ok(diagnostics.every(({ filename }) => filename.endsWith("/bad.ts")));
});
