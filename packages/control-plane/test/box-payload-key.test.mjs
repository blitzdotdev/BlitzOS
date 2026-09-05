import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  boxPayloadPrefix,
  boxPayloadVersion,
  writeBoxPayloadVersionStamp,
} from "../scripts/box-payload-key.mjs";

const A = "a".repeat(64);
const B = "b".repeat(64);

test("payload versions hash only canonical installable content", () => {
  const content = {
    files: [
      { path: "rootfs/b", sha256: B, mode: "0644" },
      { path: "rootfs/a", sha256: A, mode: "0755" },
    ],
    restart: {
      zeta: ["rootfs/b", "rootfs/a"],
      alpha: ["rootfs/b"],
    },
  };
  const canonical = {
    files: [
      ["rootfs/a", A, "0755"],
      ["rootfs/b", B, "0644"],
    ],
    daemon: "none",
    restart: [
      ["alpha", ["rootfs/b"]],
      ["zeta", ["rootfs/a", "rootfs/b"]],
    ],
  };
  const expected = createHash("sha256")
    .update(`${JSON.stringify(canonical)}\n`)
    .digest("hex");
  assert.equal(boxPayloadVersion(content), expected);
  assert.equal(boxPayloadVersion({
    files: [...content.files].reverse(),
    restart: { alpha: ["rootfs/b"], zeta: ["rootfs/a", "rootfs/b"] },
  }), expected);
  assert.equal(boxPayloadPrefix(expected), `box-payload/${expected}`);
});

test("the daemon archive digest participates and unrelated metadata cannot", () => {
  const content = {
    files: [{ path: "rootfs/a", sha256: A, mode: "0755" }],
    restart: {},
  };
  const withoutDaemon = boxPayloadVersion(content);
  const withDaemon = boxPayloadVersion({ ...content, daemonSha256: B });
  assert.notEqual(withDaemon, withoutDaemon);
  assert.equal(boxPayloadVersion({ ...content, createdAt: 123 }), withoutDaemon);
});

test("the Docker stamp accepts only a derived SHA-256 version", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "blitz-payload-stamp-"));
  try {
    await writeBoxPayloadVersionStamp(directory, A);
    assert.equal(readFileSync(path.join(directory, "payload-version"), "utf8"), `${A}\n`);
    await assert.rejects(
      () => writeBoxPayloadVersionStamp(directory, "baked"),
      /payload version/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
