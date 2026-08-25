import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { boxImageDecision, IMAGE_PATHS } from "../scripts/check-box-image.mjs";
import { configKeyPaths, missingConfigKeys } from "../scripts/config-drift.mjs";
import { deploymentVersionIds, rollbackTarget } from "../scripts/rollback.mjs";

const fixturesDirectory = fileURLToPath(
  new URL("../../schema/fixtures/version/", import.meta.url),
);
const packageDirectory = fileURLToPath(new URL("..", import.meta.url));

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
