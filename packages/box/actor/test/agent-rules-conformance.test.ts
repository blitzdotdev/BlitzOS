import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/** Consumer side of the `agent-rules` cross-runtime contract. The control-plane
 * producer is pinned against the same fixtures in
 * packages/control-plane/test/agent-rules-conformance.test.ts; here the real
 * `blitz-rules sync` CLI is driven against a local origin and its writes (or its
 * refusal to write) are checked against the fixture shape. */

interface AgentRulesFixture {
  response: { version?: string | number; content?: string };
  accepts: boolean;
}

const scriptPath = fileURLToPath(
  new URL("../../rootfs/usr/local/bin/blitz-rules", import.meta.url),
);
const fixturesDirectory = fileURLToPath(
  new URL("../../../schema/fixtures/agent-rules/", import.meta.url),
);

const BAKED = "# baked fallback rules\n";

/** limits.json is the shared size definition, not an envelope fixture. */
const LIMITS_FIXTURE = "limits.json";

function fixtureNames(): string[] {
  return readdirSync(fixturesDirectory)
    .filter((name) => name.endsWith(".json") && name !== LIMITS_FIXTURE)
    .sort();
}

function sharedMaxContentBytes(): number {
  // SAFETY: Trusted local test data authored to the { maxContentBytes } shape;
  // the control-plane producer test reads the same file.
  const limits = JSON.parse(
    readFileSync(join(fixturesDirectory, LIMITS_FIXTURE), "utf8"),
  ) as { maxContentBytes: number };
  return limits.maxContentBytes;
}

function readFixture(name: string): AgentRulesFixture {
  // SAFETY: The agent-rules fixtures are trusted local test data authored to
  // the AgentRulesFixture shape; the control-plane producer test pins the same
  // corpus.
  return JSON.parse(readFileSync(join(fixturesDirectory, name), "utf8")) as AgentRulesFixture;
}

interface BoxState {
  stateDir: string;
  home: string;
  claudePath: string;
  codexPath: string;
}

function makeState(origin: string | null, token: string | null): BoxState {
  const stateDir = mkdtempSync(join(tmpdir(), "rules-state-"));
  const home = mkdtempSync(join(tmpdir(), "rules-home-"));
  if (origin !== null) writeFileSync(join(stateDir, "origin"), `${origin}\n`);
  if (token !== null) {
    writeFileSync(
      join(stateDir, "box-credential.json"),
      `${JSON.stringify({ box_id: "box", access_token: token, refresh_token: "refresh" })}\n`,
    );
  }
  // Pre-seed the baked fallback that blitz-init-state installs at boot, so a
  // refusal to write is observable as "the baked copy survived".
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".claude", "CLAUDE.md"), BAKED);
  writeFileSync(join(home, ".codex", "AGENTS.md"), BAKED);
  return {
    stateDir,
    home,
    claudePath: join(home, ".claude", "CLAUDE.md"),
    codexPath: join(home, ".codex", "AGENTS.md"),
  };
}

interface RunResult {
  status: number | null;
  stderr: string;
}

function runSync(state: BoxState): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("sh", [scriptPath, "sync"], {
      env: { ...process.env, BLITZ_STATE_DIR: state.stateDir, HOME: state.home },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (status) => resolve({ status, stderr: stderr.trim() }));
  });
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

function serveBody(status: number, body: string): Promise<string> {
  return startServer((req, res) => {
    if (req.url !== "/workspaces/self/agent-rules") {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.headers.authorization !== "Bearer good-token") {
      res.writeHead(401);
      res.end();
      return;
    }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function expectBakedPreserved(state: BoxState): void {
  expect(readFileSync(state.claudePath, "utf8")).toBe(BAKED);
  expect(readFileSync(state.codexPath, "utf8")).toBe(BAKED);
}

describe("blitz-rules sync consumer contract", () => {
  it("pins the shared agent-rules fixture corpus", () => {
    expect(fixtureNames()).toEqual([
      "empty-content.json",
      "missing-content.json",
      "missing-version.json",
      "non-string-version.json",
      "valid-minimal.json",
    ]);
  });

  it("writes both read paths only for an accepted envelope, else keeps the baked copy", async () => {
    for (const name of fixtureNames()) {
      const fixture = readFixture(name);
      const origin = await serveBody(200, JSON.stringify(fixture.response));
      const state = makeState(origin, "good-token");

      const result = await runSync(state);
      expect(result.status, `${name}: ${result.stderr}`).toBe(0);

      if (fixture.accepts) {
        const expected = fixture.response.content;
        if (expected === undefined) throw new Error(`${name} is accepted but has no content`);
        expect(readFileSync(state.claudePath, "utf8"), name).toBe(expected);
        expect(readFileSync(state.codexPath, "utf8"), name).toBe(expected);
        expect(statSync(state.claudePath).mode & 0o777, name).toBe(0o644);
        expect(statSync(state.codexPath).mode & 0o777, name).toBe(0o644);
      } else {
        expectBakedPreserved(state);
      }
    }
  });

  it("falls back on a non-200 response", async () => {
    const origin = await serveBody(500, "boom");
    const state = makeState(origin, "good-token");
    const result = await runSync(state);
    expect(result.status).toBe(0);
    expectBakedPreserved(state);
  });

  it("falls back on an authentication failure", async () => {
    const origin = await serveBody(200, JSON.stringify({ version: "abc123", content: "x\n" }));
    const state = makeState(origin, "wrong-token");
    const result = await runSync(state);
    expect(result.status).toBe(0);
    expectBakedPreserved(state);
  });

  it("falls back when the origin is unreachable", async () => {
    // Port 1 is never listening; the fetch fails at connect.
    const state = makeState("http://127.0.0.1:1", "good-token");
    const result = await runSync(state);
    expect(result.status).toBe(0);
    expectBakedPreserved(state);
  });

  it("falls back when origin or credential is missing", async () => {
    const noOrigin = makeState(null, "good-token");
    const noCredential = makeState("https://cp.example", null);

    expect((await runSync(noOrigin)).status).toBe(0);
    expect((await runSync(noCredential)).status).toBe(0);
    expectBakedPreserved(noOrigin);
    expectBakedPreserved(noCredential);
  });

  // The control plane stores a rule whose `content` is at most this many UTF-8
  // bytes. This reader must accept every one of them, or the picker can select
  // a rule that no box will ever install. Both sides measure `content` after
  // parsing: not the JSON envelope (escaping expands it) and not String#length
  // (which counts UTF-16 units, so a non-ASCII document would be mismeasured).
  it("installs any document within the shared byte cap and refuses one past it", async () => {
    const maxBytes = sharedMaxContentBytes();

    // Exactly at the cap.
    const atCap = "x".repeat(maxBytes);
    expect(Buffer.byteLength(atCap, "utf8")).toBe(maxBytes);
    const atCapOrigin = await serveBody(200, JSON.stringify({ version: "v1", content: atCap }));
    const atCapState = makeState(atCapOrigin, "good-token");
    expect((await runSync(atCapState)).status).toBe(0);
    expect(readFileSync(atCapState.claudePath, "utf8")).toBe(atCap);

    // One byte past it: the baked copy stays.
    const overCap = "x".repeat(maxBytes + 1);
    const overOrigin = await serveBody(200, JSON.stringify({ version: "v1", content: overCap }));
    const overState = makeState(overOrigin, "good-token");
    expect((await runSync(overState)).status).toBe(0);
    expectBakedPreserved(overState);

    // Non-ASCII at the cap: two bytes per character, so half the cap in
    // characters. Measuring String#length would have wrongly accepted twice
    // this much.
    const accented = "é".repeat(maxBytes / 2);
    expect(Buffer.byteLength(accented, "utf8")).toBe(maxBytes);
    const accentedOrigin = await serveBody(
      200,
      JSON.stringify({ version: "v1", content: accented }),
    );
    const accentedState = makeState(accentedOrigin, "good-token");
    expect((await runSync(accentedState)).status).toBe(0);
    expect(readFileSync(accentedState.claudePath, "utf8")).toBe(accented);

    const accentedOver = "é".repeat(maxBytes / 2 + 1);
    const accentedOverOrigin = await serveBody(
      200,
      JSON.stringify({ version: "v1", content: accentedOver }),
    );
    const accentedOverState = makeState(accentedOverOrigin, "good-token");
    expect((await runSync(accentedOverState)).status).toBe(0);
    expectBakedPreserved(accentedOverState);

    // A document at the cap whose envelope is more than twice the cap, because
    // every byte escapes. Capping the raw body would have refused it.
    const newlines = "\n".repeat(maxBytes);
    const envelope = JSON.stringify({ version: "v1", content: newlines });
    expect(envelope.length).toBeGreaterThan(maxBytes * 2);
    const escapedOrigin = await serveBody(200, envelope);
    const escapedState = makeState(escapedOrigin, "good-token");
    expect((await runSync(escapedState)).status).toBe(0);
    expect(readFileSync(escapedState.claudePath, "utf8")).toBe(newlines);
  });

  it("rejects an unknown subcommand with exit 2 and writes nothing", async () => {
    const state = makeState("https://cp.example", "good-token");
    const result = await new Promise<RunResult>((resolve) => {
      const child = spawn("sh", [scriptPath, "bogus"], {
        env: { ...process.env, BLITZ_STATE_DIR: state.stateDir, HOME: state.home },
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("close", (status) => resolve({ status, stderr: stderr.trim() }));
    });
    expect(result.status).toBe(2);
    expectBakedPreserved(state);
  });
});
