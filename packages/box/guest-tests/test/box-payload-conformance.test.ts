import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Consumer side of the box-payload v1 contract. This test invokes the real
 * base-image updater instead of copying its parser into TypeScript; the
 * control-plane producer/consumer test runs the schema parser over this same
 * corpus. */

const updater = fileURLToPath(
  new URL("../../rootfs/usr/local/libexec/blitz-payload", import.meta.url),
);
const fixtures = fileURLToPath(
  new URL("../../../schema/fixtures/box-payload/", import.meta.url),
);

interface InvalidCases {
  [fixture: string]: string;
}

function invalidCases(): InvalidCases {
  // SAFETY: cases.json is trusted repository data and this test checks every
  // value before using it as the expected error fragment.
  const parsed = JSON.parse(readFileSync(path.join(fixtures, "cases.json"), "utf8")) as InvalidCases;
  for (const [fixture, field] of Object.entries(parsed)) {
    if (fixture === "" || typeof field !== "string") throw new Error("invalid box-payload cases.json");
  }
  return parsed;
}

function fixtureNames(relativeDirectory: string): string[] {
  return readdirSync(path.join(fixtures, relativeDirectory))
    .filter((name) => name.endsWith(".json"))
    .map((name) => `${relativeDirectory}/${name}`)
    .sort();
}

function validate(fixture: string): { status: number | null; stderr: string } {
  const command = fixture.startsWith("payload-result/")
    ? "validate-result"
    : "validate-manifest";
  const result = spawnSync(process.execPath, [updater, command, path.join(fixtures, fixture)], {
    encoding: "utf8",
  });
  return { status: result.status, stderr: result.stderr };
}

describe("blitz-payload fixture conformance", () => {
  it("accepts every valid manifest, including an unsupported updater version", () => {
    const names = fixtureNames("valid");
    expect(names).toEqual([
      "valid/full-manifest.json",
      "valid/min-updater-unsupported.json",
      "valid/no-daemon.json",
      "valid/single-file.json",
    ]);
    for (const fixture of names) {
      const result = validate(fixture);
      expect(result.status, `${fixture}: ${result.stderr}`).toBe(0);
    }
  });

  it("accepts every valid updater result body", () => {
    const names = fixtureNames("payload-result/valid");
    expect(names).toHaveLength(7);
    for (const fixture of names) {
      const result = validate(fixture);
      expect(result.status, `${fixture}: ${result.stderr}`).toBe(0);
    }
  });

  it("rejects every invalid fixture with the schema parser's field name", () => {
    const cases = invalidCases();
    const names = [
      ...fixtureNames("invalid"),
      ...fixtureNames("payload-result/invalid"),
    ].sort();
    expect(names).toEqual(Object.keys(cases).sort());
    for (const fixture of names) {
      const result = validate(fixture);
      expect(result.status, fixture).toBe(1);
      expect(result.stderr, fixture).toContain(cases[fixture]);
    }
  });
});
