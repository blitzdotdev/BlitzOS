import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  boxPayloadPrefix,
  boxPayloadVersion,
  resolveBoxPayloadVersion,
} from "../scripts/box-payload-key.mjs";

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

test("an archive-less Docker context requires a valid planned version", async () => {
  const repository = mkdtempSync(path.join(tmpdir(), "blitz-payload-no-git-"));
  try {
    await assert.rejects(
      () => resolveBoxPayloadVersion({ repo: repository }),
      /box-payload input is missing/u,
    );
    const providedVersion = "a".repeat(64);
    assert.equal(
      await resolveBoxPayloadVersion({ repo: repository, providedVersion }),
      providedVersion,
    );
    await assert.rejects(
      () => resolveBoxPayloadVersion({ repo: repository, providedVersion: "baked" }),
      /BLITZ_PAYLOAD_VERSION/u,
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
