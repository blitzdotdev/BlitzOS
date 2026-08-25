import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { boxImageDecision, IMAGE_PATHS } from "../scripts/check-box-image.mjs";
import {
  COMPARED_LISTS,
  configKeyPaths,
  missingConfigKeys,
  missingListEntries,
} from "../scripts/config-drift.mjs";
import { isNonEmptyString, isTable } from "../scripts/lib/values.mjs";
import { deploymentVersionIds, rollbackTarget } from "../scripts/rollback.mjs";

const fixturesDirectory = fileURLToPath(
  new URL("../../schema/fixtures/version/", import.meta.url),
);
const packageDirectory = fileURLToPath(new URL("..", import.meta.url));

// --- value decoders ---------------------------------------------------------

test("isTable accepts a table and rejects what typeof gets wrong", () => {
  assert.equal(isTable({ a: 1 }), true);
  // The three cases `typeof x === "object"` answers true for, wrongly.
  assert.equal(isTable(null), false);
  assert.equal(isTable([1, 2]), false);
  assert.equal(isTable(new Date(0)), false);
  assert.equal(isTable(undefined), false);
  assert.equal(isTable("x"), false);
  assert.equal(isTable(1), false);
});

test("isNonEmptyString accepts a primitive string only", () => {
  assert.equal(isNonEmptyString("abc"), true);
  assert.equal(isNonEmptyString(""), false);
  assert.equal(isNonEmptyString(null), false);
  assert.equal(isNonEmptyString(undefined), false);
  assert.equal(isNonEmptyString(1), false);
  assert.equal(isNonEmptyString(["a"]), false);
  // A boxed String is not a string value, and must not pass as one.
  assert.equal(isNonEmptyString(new String("abc")), false);
});

// --- config drift -----------------------------------------------------------

test("configKeyPaths flattens tables and arrays of tables", () => {
  const paths = configKeyPaths({
    name: "w",
    vars: { APP_URL: "" },
    d1_databases: [{ binding: "DB", database_id: "x" }],
  });
  assert.ok(paths.has("name"));
  assert.ok(paths.has("vars.APP_URL"));
  assert.ok(paths.has("d1_databases[].binding"));
});

test("missingConfigKeys names a key the example gained", () => {
  const example = '[vars]\nAPP_URL = ""\nGIT_COMMIT_SHA = ""\n';
  const config = '[vars]\nAPP_URL = "https://x"\n';
  assert.deepEqual(missingConfigKeys(example, config), ["vars.GIT_COMMIT_SHA"]);
});

test("missingConfigKeys ignores values and extra keys", () => {
  const example = '[vars]\nAPP_URL = ""\n';
  const config = '[vars]\nAPP_URL = "https://x"\nEXTRA = "1"\n';
  assert.deepEqual(missingConfigKeys(example, config), []);
});

test("a config generated from the example carries every key", () => {
  // ensure-wrangler-config.mjs re-serializes the example, so a fresh clone must
  // never trip the drift gate.
  const example = readFileSync(path.join(packageDirectory, "wrangler.toml.example"), "utf8");
  assert.deepEqual(missingConfigKeys(example, example), []);
});

test("the example declares GIT_COMMIT_SHA and routes /version to the worker", () => {
  const example = readFileSync(path.join(packageDirectory, "wrangler.toml.example"), "utf8");
  assert.match(example, /GIT_COMMIT_SHA/u);
  assert.match(example, /"\/version"/u);
});

// --- routing list drift -----------------------------------------------------

// The case this check was added for. /version reached wrangler.toml.example and
// neither deployment config, and the key-path comparison passed both, because
// run_worker_first is a key every config has.
const EXAMPLE_ASSETS = [
  "[assets]",
  'run_worker_first = [ "/sessions*", "/version", "/api/*" ]',
  "",
  "[triggers]",
  'crons = [ "*/5 * * * *", "0 3 * * *" ]',
  "",
].join("\n");

test("missingListEntries names a route the config never routes to the worker", () => {
  const config = [
    "[assets]",
    'run_worker_first = [ "/sessions*", "/api/*" ]',
    "",
    "[triggers]",
    'crons = [ "*/5 * * * *", "0 3 * * *" ]',
    "",
  ].join("\n");
  assert.deepEqual(missingListEntries(EXAMPLE_ASSETS, config), [
    { path: "assets.run_worker_first", missing: ["/version"] },
  ]);
});

test("missingListEntries names a missing cron", () => {
  const config = [
    "[assets]",
    'run_worker_first = [ "/sessions*", "/version", "/api/*" ]',
    "",
    "[triggers]",
    'crons = [ "*/5 * * * *" ]',
    "",
  ].join("\n");
  assert.deepEqual(missingListEntries(EXAMPLE_ASSETS, config), [
    { path: "triggers.crons", missing: ["0 3 * * *"] },
  ]);
});

test("a config may route more than the example, and that is not drift", () => {
  const config = [
    "[assets]",
    'run_worker_first = [ "/sessions*", "/version", "/api/*", "/extra*" ]',
    "",
    "[triggers]",
    'crons = [ "*/5 * * * *", "0 3 * * *" ]',
    "",
  ].join("\n");
  assert.deepEqual(missingListEntries(EXAMPLE_ASSETS, config), []);
});

test("an absent table reports every entry rather than passing quietly", () => {
  assert.deepEqual(missingListEntries(EXAMPLE_ASSETS, 'name = "w"\n'), [
    { path: "assets.run_worker_first", missing: ["/sessions*", "/version", "/api/*"] },
    { path: "triggers.crons", missing: ["*/5 * * * *", "0 3 * * *"] },
  ]);
});

test("the example agrees with itself on every compared list", () => {
  const example = readFileSync(path.join(packageDirectory, "wrangler.toml.example"), "utf8");
  assert.deepEqual(missingListEntries(example, example), []);
});

test("COMPARED_LISTS covers the two lists that route requests", () => {
  assert.deepEqual(COMPARED_LISTS.map((entry) => entry.join(".")), [
    "assets.run_worker_first",
    "triggers.crons",
  ]);
});

// --- box image decision -----------------------------------------------------

test("no image path changed means no rebuild", () => {
  const decision = boxImageDecision("abc1234", ["packages/webapp/src/App.tsx"]);
  assert.equal(decision.rebuild, false);
  assert.deepEqual(decision.paths, []);
});

test("a box change requires a rebuild", () => {
  const decision = boxImageDecision("abc1234", [
    "packages/box/actor/src/actor.ts",
    "packages/webapp/src/App.tsx",
  ]);
  assert.equal(decision.rebuild, true);
  assert.deepEqual(decision.paths, ["packages/box/actor/src/actor.ts"]);
});

test("a broker change requires a rebuild", () => {
  assert.equal(boxImageDecision("abc", ["packages/broker/main.go"]).rebuild, true);
});

test("a path that merely starts with an image path prefix does not count", () => {
  // "packages/boxes/..." is not "packages/box/...".
  assert.equal(boxImageDecision("abc", ["packages/boxes/thing.ts"]).rebuild, false);
});

test("IMAGE_PATHS names both image sources", () => {
  assert.deepEqual([...IMAGE_PATHS], ["packages/box", "packages/broker"]);
});

// --- the /version contract, consumer side -----------------------------------

test("every version fixture carries the fields the consumer reads", () => {
  for (const name of ["deployed.json", "unknown-commit.json", "fresh-database.json"]) {
    const body = JSON.parse(readFileSync(path.join(fixturesDirectory, name), "utf8"));
    assert.equal(typeof body.commit, "string", name);
    assert.notEqual(body.commit, "", name);
    assert.equal(typeof body.boxImageRef, "string", name);
    assert.ok(body.migration === null || typeof body.migration === "string", name);
  }
});

// --- rollback ---------------------------------------------------------------

const deployment = (createdOn, ...versionIds) => ({
  created_on: createdOn,
  versions: versionIds.map((id) => ({ version_id: id })),
});

test("deploymentVersionIds reads both version_id and id spellings", () => {
  assert.deepEqual(deploymentVersionIds({ versions: [{ version_id: "a" }, { id: "b" }] }), ["a", "b"]);
  assert.deepEqual(deploymentVersionIds({}), []);
  assert.deepEqual(deploymentVersionIds(null), []);
});

test("rollbackTarget picks the previous single-version deployment", () => {
  const { current, target } = rollbackTarget([
    deployment("2026-08-20T00:00:00Z", "old"),
    deployment("2026-08-25T00:00:00Z", "new"),
  ]);
  assert.equal(current, "new");
  assert.equal(target, "old");
});

test("rollbackTarget skips a deployment that served the same version again", () => {
  const { target } = rollbackTarget([
    deployment("2026-08-19T00:00:00Z", "older"),
    deployment("2026-08-20T00:00:00Z", "new"),
    deployment("2026-08-25T00:00:00Z", "new"),
  ]);
  assert.equal(target, "older");
});

test("rollbackTarget refuses to guess during a split", () => {
  assert.throws(
    () => rollbackTarget([deployment("2026-08-25T00:00:00Z", "a", "b")]),
    /serves 2 versions at once/u,
  );
});

test("rollbackTarget refuses when nothing earlier exists", () => {
  assert.throws(
    () => rollbackTarget([deployment("2026-08-25T00:00:00Z", "only")]),
    /nothing to roll back to/u,
  );
});

test("rollbackTarget rejects an empty list", () => {
  assert.throws(() => rollbackTarget([]), /no deployments/u);
});
