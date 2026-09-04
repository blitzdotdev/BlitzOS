import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { boxPayloadPrefix, boxPayloadVersion } from "../scripts/box-payload-key.mjs";

test("payload versions hash sorted path and Git object-id records", () => {
  const entries = [
    { path: "a", id: "1".repeat(40) },
    { path: "b", id: "2".repeat(40) },
  ];
  const expected = createHash("sha256")
    .update(`a\t${"1".repeat(40)}\nb\t${"2".repeat(40)}\n`)
    .digest("hex");
  assert.equal(boxPayloadVersion(entries), expected);
  assert.equal(boxPayloadPrefix(expected), `box-payload/${expected}`);
});

