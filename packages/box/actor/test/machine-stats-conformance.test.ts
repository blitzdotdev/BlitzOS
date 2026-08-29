import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/** Producer side of the `machine-stats` cross-runtime contract. The
 * control-plane consumer is pinned against the same fixtures in
 * packages/control-plane/test/machine-stats-conformance.test.ts; here the real
 * `blitz-machine-stats report` script runs against a local origin and what it
 * posts is checked against the corpus accept rule. */

interface StatsFixture {
  request: Record<string, unknown>;
  accepts: boolean;
}

const scriptPath = fileURLToPath(
  new URL("../../rootfs/usr/local/bin/blitz-machine-stats", import.meta.url),
);
const fixturesDirectory = fileURLToPath(
  new URL("../../../schema/fixtures/machine-stats/", import.meta.url),
);

function fixtureNames(): string[] {
  return readdirSync(fixturesDirectory).filter((name) => name.endsWith(".json")).sort();
}

function readFixture(name: string): StatsFixture {
  // SAFETY: The machine-stats fixtures are trusted local test data authored to
  // the { request, accepts } shape; the control-plane consumer test pins the
  // same corpus.
  return JSON.parse(readFileSync(join(fixturesDirectory, name), "utf8")) as StatsFixture;
}

/** The corpus accept rule, restated here so the producer is checked against
 * the same sentence the consumer implements: an object whose `diskUsedPercent`
 * is an integer 0-100. The fixture list is the proof that this restatement and
 * the control plane's agree. */
function accepts(body: unknown): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const percent = (body as { diskUsedPercent?: unknown }).diskUsedPercent;
  return typeof percent === "number" && Number.isInteger(percent)
    && percent >= 0 && percent <= 100;
}

interface BoxState {
  stateDir: string;
}

function makeState(origin: string | null, token: string | null): BoxState {
  const stateDir = mkdtempSync(join(tmpdir(), "stats-state-"));
  if (origin !== null) writeFileSync(join(stateDir, "origin"), `${origin}\n`);
  if (token !== null) {
    writeFileSync(
      join(stateDir, "box-credential.json"),
      `${JSON.stringify({ box_id: "box", access_token: token, refresh_token: "refresh" })}\n`,
    );
  }
  return { stateDir };
}

interface RunResult {
  status: number | null;
  stderr: string;
}

function runReport(state: BoxState): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("sh", [scriptPath, "report"], {
      env: { ...process.env, BLITZ_STATE_DIR: state.stateDir },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (status) => resolve({ status, stderr: stderr.trim() }));
  });
}

interface Posted {
  authorization: string | undefined;
  contentType: string | undefined;
  body: unknown;
}

const servers: Server[] = [];

function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      // SAFETY: The callback runs after binding an explicit TCP host/port, so
      // address() is an AddressInfo, never a pipe string or null.
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

/** A stand-in control plane that records the one report it is sent. */
function collector(status: number, posted: Posted[]): Promise<string> {
  return startServer((req, res) => {
    if (req.url !== "/workspaces/self/machine-stats" || req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.headers.authorization !== "Bearer good-token") {
      res.writeHead(401);
      res.end();
      return;
    }
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      let body: unknown = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
      posted.push({
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
        body,
      });
      res.writeHead(status);
      res.end();
    });
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("blitz-machine-stats producer contract", () => {
  it("pins the shared machine-stats fixture corpus", () => {
    expect(fixtureNames()).toEqual([
      "invalid-fractional-percent.json",
      "invalid-missing-percent.json",
      "invalid-negative-percent.json",
      "invalid-null-percent.json",
      "invalid-over-hundred.json",
      "invalid-string-percent.json",
      "valid-extra-key.json",
      "valid-full.json",
      "valid-mid.json",
      "valid-zero.json",
    ]);
  });

  it("agrees with the corpus about which bodies the control plane takes", () => {
    for (const name of fixtureNames()) {
      const fixture = readFixture(name);
      expect(accepts(fixture.request), name).toBe(fixture.accepts);
    }
  });

  it("posts a body the control plane accepts, with the box credential", async () => {
    const posted: Posted[] = [];
    const origin = await collector(204, posted);
    const state = makeState(origin, "good-token");

    const result = await runReport(state);

    expect(result.status, result.stderr).toBe(0);
    expect(posted).toHaveLength(1);
    const report = posted[0];
    expect(report?.authorization).toBe("Bearer good-token");
    expect(report?.contentType).toBe("application/json");
    expect(accepts(report?.body)).toBe(true);
    // The one key the contract names, and no other: an integer percentage
    // measured off a real filesystem, this test's own temporary directory.
    expect(Object.keys(report?.body as Record<string, unknown>)).toEqual(["diskUsedPercent"]);
  });

  it("stays quiet and succeeds when there is nothing to report with", async () => {
    const posted: Posted[] = [];
    const origin = await collector(204, posted);

    for (const state of [makeState(null, "good-token"), makeState(origin, null)]) {
      const result = await runReport(state);
      expect(result.status, result.stderr).toBe(0);
    }
    expect(posted).toHaveLength(0);
  });

  it("fails open on a refused or broken control plane", async () => {
    const posted: Posted[] = [];
    const refusing = await collector(204, posted);
    // Wrong token: the collector answers 401 before it records anything.
    expect((await runReport(makeState(refusing, "wrong-token"))).status).toBe(0);
    expect(posted).toHaveLength(0);

    const failing = await collector(500, posted);
    expect((await runReport(makeState(failing, "good-token"))).status).toBe(0);

    // Nothing is listening on this port, so the fetch itself fails.
    const dead = makeState("http://127.0.0.1:1", "good-token");
    expect((await runReport(dead)).status).toBe(0);
  });
});
