import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Producer side of the `preview-focus` cross-runtime contract. The Go gateway
 * reader is pinned against the same fixtures in
 * packages/box/gateway/main_test.go; here the real `blitz preview open` CLI is
 * driven and its marker file is checked against the fixture shape. */

interface FocusMarker {
  version: number;
  port: number;
  path: string;
  title: string;
  requestedAt: number;
}

interface Fixture {
  input: FocusMarker | null;
  expected: { focus: FocusMarker | null };
}

interface ReservedPorts {
  minPort: number;
  maxPort: number;
  maxPathLength: number;
  reservedPorts: number[];
}

const blitzPath = fileURLToPath(new URL("../../rootfs/usr/local/bin/blitz", import.meta.url));
const fixturesDirectory = fileURLToPath(
  new URL("../../../schema/fixtures/preview-focus/", import.meta.url),
);
const reservedPortsPath = fileURLToPath(
  new URL("../../../schema/fixtures/preview-ports/reserved.json", import.meta.url),
);

function reservedPorts(): ReservedPorts {
  // SAFETY: Trusted local test data authored to the ReservedPorts shape; the Go
  // gateway test pins the identical file.
  return JSON.parse(readFileSync(reservedPortsPath, "utf8")) as ReservedPorts;
}

function fixtureNames(): string[] {
  return readdirSync(fixturesDirectory)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

function readFixture(name: string): Fixture {
  // SAFETY: The preview-focus fixtures are trusted local test data authored to
  // the Fixture shape; the Go conformance test pins the identical corpus.
  return JSON.parse(readFileSync(join(fixturesDirectory, name), "utf8")) as Fixture;
}

interface OpenResult {
  status: number | null;
  stderr: string;
  focusPath: string;
}

function runOpen(args: string[]): OpenResult {
  const directory = mkdtempSync(join(tmpdir(), "preview-focus-"));
  const focusPath = join(directory, "preview-focus.json");
  const result = spawnSync("sh", [blitzPath, "preview", "open", ...args], {
    encoding: "utf8",
    env: { ...process.env, BLITZ_PREVIEW_FOCUS_PATH: focusPath },
  });
  return { status: result.status, stderr: result.stderr, focusPath };
}

function readMarker(focusPath: string): FocusMarker {
  // SAFETY: Read only after asserting the CLI exited 0 and wrote the file, so
  // the bytes are exactly the object the producer emits.
  return JSON.parse(readFileSync(focusPath, "utf8")) as FocusMarker;
}

function withoutRequestedAt(marker: FocusMarker): Omit<FocusMarker, "requestedAt"> {
  return { version: marker.version, port: marker.port, path: marker.path, title: marker.title };
}

describe("blitz preview open producer contract", () => {
  it("pins the shared preview-focus fixture corpus", () => {
    expect(fixtureNames()).toEqual([
      "absent.json",
      "bad-path.json",
      "reserved-port-17445.json",
      "reserved-port-7446.json",
      "reserved-port.json",
      "traversal-path.json",
      "valid-defaults.json",
      "valid-with-path.json",
    ]);
  });

  it("refuses every port the shared reserved set names", () => {
    const { minPort, maxPort, reservedPorts: reserved } = reservedPorts();
    expect(reserved.length).toBeGreaterThan(0);
    for (const port of reserved) {
      const { status, focusPath } = runOpen([String(port)]);
      expect(status, `reserved port ${String(port)}`).toBe(2);
      expect(existsSync(focusPath), `reserved port ${String(port)}`).toBe(false);
    }
    // The ends of the usable range still open, so the set is a hole in a range
    // rather than a narrower range.
    for (const port of [minPort, maxPort]) {
      const { status, stderr, focusPath } = runOpen([String(port)]);
      expect(status, stderr).toBe(0);
      expect(readMarker(focusPath).port).toBe(port);
    }
  });

  it("refuses a path longer than the persisted document allows", () => {
    const { maxPathLength } = reservedPorts();
    const longest = `/${"a".repeat(maxPathLength - 1)}`;
    const tooLong = `/${"a".repeat(maxPathLength)}`;

    const kept = runOpen(["3000", "--path", longest]);
    expect(kept.status, kept.stderr).toBe(0);
    expect(readMarker(kept.focusPath).path).toBe(longest);

    const refused = runOpen(["3000", "--path", tooLong]);
    expect(refused.status).toBe(2);
    expect(existsSync(refused.focusPath)).toBe(false);
  });

  it("emits the fixture marker shape for every valid fixture", () => {
    // Valid fixtures are the ones the gateway accepts (non-null focus); the
    // rejection fixtures carry a bad marker the CLI would never write.
    const valid = fixtureNames()
      .map((name) => readFixture(name))
      .filter((fixture): fixture is { input: FocusMarker; expected: { focus: FocusMarker } } =>
        fixture.input !== null && fixture.expected.focus !== null);
    expect(valid.length).toBeGreaterThan(0);
    for (const fixture of valid) {
      const marker = fixture.input;
      const { status, stderr, focusPath } = runOpen([
        String(marker.port),
        "--path",
        marker.path,
        "--title",
        marker.title,
      ]);
      expect(status, stderr).toBe(0);
      const emitted = readMarker(focusPath);
      expect(withoutRequestedAt(emitted)).toEqual(withoutRequestedAt(marker));
      expect(Number.isSafeInteger(emitted.requestedAt)).toBe(true);
      expect(emitted.requestedAt).toBeGreaterThan(0);
    }
  });

  it("defaults the path to / and the title to port <N>", () => {
    const { status, stderr, focusPath } = runOpen(["4321"]);
    expect(status, stderr).toBe(0);
    const marker = readMarker(focusPath);
    expect(marker.version).toBe(1);
    expect(marker.port).toBe(4321);
    expect(marker.path).toBe("/");
    expect(marker.title).toBe("port 4321");
  });

  it("rejects invalid invocations with exit 2 and writes no marker", () => {
    const cases: Array<{ name: string; args: string[] }> = [
      { name: "reserved port", args: ["7445"] },
      { name: "below range", args: ["80"] },
      { name: "above range", args: ["70000"] },
      { name: "port 22", args: ["22"] },
      { name: "non-integer port", args: ["abc"] },
      { name: "missing port", args: [] },
      { name: "path without leading slash", args: ["3000", "--path", "dashboard"] },
      { name: "path with traversal", args: ["3000", "--path", "/a/../b"] },
      { name: "unknown option", args: ["3000", "--frag", "x"] },
      { name: "flag without value", args: ["3000", "--path"] },
    ];
    for (const { name, args } of cases) {
      const { status, focusPath } = runOpen(args);
      expect(status, name).toBe(2);
      expect(existsSync(focusPath), name).toBe(false);
    }
  });
});
