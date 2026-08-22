import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Producer side of the `connections-focus` cross-runtime contract. The Go
 * gateway reader is pinned against the same fixtures in
 * packages/box/gateway/main_test.go, the browser consumer in
 * packages/webapp/test/connections-focus.test.ts; here the real
 * `blitz connections open` CLI is driven and its marker file is checked
 * against the fixture shape. */

interface FocusMarker {
  version: number;
  provider: string;
  requestedAt: number;
}

interface Fixture {
  input: FocusMarker | null;
  expected: { focus: FocusMarker | null };
}

const blitzPath = fileURLToPath(new URL("../../rootfs/usr/local/bin/blitz", import.meta.url));
const fixturesDirectory = fileURLToPath(
  new URL("../../../schema/fixtures/connections-focus/", import.meta.url),
);

function fixtureNames(): string[] {
  return readdirSync(fixturesDirectory)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

function readFixture(name: string): Fixture {
  // SAFETY: The connections-focus fixtures are trusted local test data
  // authored to the Fixture shape; the Go conformance test pins the identical
  // corpus.
  return JSON.parse(readFileSync(join(fixturesDirectory, name), "utf8")) as Fixture;
}

interface OpenResult {
  status: number | null;
  stderr: string;
  focusPath: string;
}

function runOpen(args: string[]): OpenResult {
  const directory = mkdtempSync(join(tmpdir(), "connections-focus-"));
  const focusPath = join(directory, "connections-focus.json");
  const result = spawnSync("sh", [blitzPath, "connections", "open", ...args], {
    encoding: "utf8",
    env: { ...process.env, BLITZ_CONNECTIONS_FOCUS_PATH: focusPath },
  });
  return { status: result.status, stderr: result.stderr, focusPath };
}

function readMarker(focusPath: string): FocusMarker {
  // SAFETY: Read only after asserting the CLI exited 0 and wrote the file, so
  // the bytes are exactly the object the producer emits.
  return JSON.parse(readFileSync(focusPath, "utf8")) as FocusMarker;
}

describe("blitz connections open producer contract", () => {
  it("pins the shared connections-focus fixture corpus", () => {
    expect(fixtureNames()).toEqual([
      "absent.json",
      "bad-provider-uppercase.json",
      "empty-provider.json",
      "long-provider-64.json",
      "long-provider.json",
      "negative-requested-at.json",
      "valid-generic-name.json",
      "valid-github.json",
      "valid-provider-63.json",
      "wrong-version.json",
    ]);
  });

  it("emits the fixture marker shape for every valid fixture", () => {
    // Valid fixtures are the ones the gateway accepts (non-null focus); the
    // rejection fixtures carry a marker the CLI would never write.
    const valid = fixtureNames()
      .map((name) => readFixture(name))
      .filter((fixture): fixture is { input: FocusMarker; expected: { focus: FocusMarker } } =>
        fixture.input !== null && fixture.expected.focus !== null);
    expect(valid.length).toBeGreaterThan(0);
    for (const fixture of valid) {
      const { status, stderr, focusPath } = runOpen([fixture.input.provider]);
      expect(status, stderr).toBe(0);
      const emitted = readMarker(focusPath);
      expect(emitted.version).toBe(fixture.input.version);
      expect(emitted.provider).toBe(fixture.input.provider);
      expect(Number.isSafeInteger(emitted.requestedAt)).toBe(true);
      expect(emitted.requestedAt).toBeGreaterThan(0);
    }
  });

  it("accepts providers at the 63-character cap and refuses 64", () => {
    // 63 is the grant validator's cap (schema `isProviderName`); the fixture
    // corpus pins both edges, this drives the real CLI over them.
    const atCap = "a".repeat(63);
    const kept = runOpen([atCap]);
    expect(kept.status, kept.stderr).toBe(0);
    expect(readMarker(kept.focusPath).provider).toBe(atCap);

    const refused = runOpen(["a".repeat(64)]);
    expect(refused.status).toBe(2);
    expect(existsSync(refused.focusPath)).toBe(false);
  });

  it("rejects invalid invocations with exit 2 and writes no marker", () => {
    const cases: Array<{ name: string; args: string[] }> = [
      { name: "missing provider", args: [] },
      { name: "empty provider", args: [""] },
      { name: "uppercase provider", args: ["GitHub"] },
      { name: "provider with a space", args: ["has space"] },
      { name: "provider starting with punctuation", args: ["-leading"] },
      { name: "provider with a slash", args: ["a/b"] },
      { name: "provider with a newline", args: ["a\nb"] },
      { name: "extra argument", args: ["github", "extra"] },
    ];
    for (const { name, args } of cases) {
      const { status, focusPath } = runOpen(args);
      expect(status, name).toBe(2);
      expect(existsSync(focusPath), name).toBe(false);
    }
  });

  it("refuses connections verbs other than open", () => {
    const directory = mkdtempSync(join(tmpdir(), "connections-focus-"));
    const focusPath = join(directory, "connections-focus.json");
    const result = spawnSync("sh", [blitzPath, "connections", "list"], {
      encoding: "utf8",
      env: { ...process.env, BLITZ_CONNECTIONS_FOCUS_PATH: focusPath },
    });
    expect(result.status).toBe(2);
    expect(existsSync(focusPath)).toBe(false);
  });
});
