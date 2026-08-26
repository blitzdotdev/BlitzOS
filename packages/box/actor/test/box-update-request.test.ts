import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/** Guest side of the `blitz box update` verb: the dispatcher reads the box
 * origin and credential exactly as `blitz-rules` does and POSTs
 * /workspaces/self/box-update with the box bearer token. The route itself is
 * covered by packages/control-plane/test/box-config-conformance.test.ts; this
 * drives the real CLI against a local origin. Unlike blitz-rules, the verb is
 * user-invoked, so failures exit nonzero instead of falling back silently. */

const scriptPath = fileURLToPath(
  new URL("../../rootfs/usr/local/bin/blitz", import.meta.url),
);

const TOKEN = "test-box-access-token";

function makeState(origin: string | null, token: string | null): string {
  const stateDir = mkdtempSync(join(tmpdir(), "box-update-state-"));
  if (origin !== null) writeFileSync(join(stateDir, "origin"), `${origin}\n`);
  if (token !== null) {
    writeFileSync(
      join(stateDir, "box-credential.json"),
      `${JSON.stringify({ box_id: "box", access_token: token, refresh_token: "refresh" })}\n`,
    );
  }
  return stateDir;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runBlitz(stateDir: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("sh", [scriptPath, ...args], {
      env: { ...process.env, BLITZ_STATE_DIR: stateDir },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const servers: Server[] = [];

interface SeenRequest {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
}

function startServer(
  status: number,
  seen: SeenRequest[],
): Promise<string> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    seen.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
    });
    response.statusCode = status;
    response.end();
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      // SAFETY: The callback runs after binding an explicit TCP host/port, so
      // address() is an AddressInfo, never a pipe string or null.
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${String(address.port)}`);
    });
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise((resolve) => server.close(resolve)),
    ),
  );
});

describe("blitz box update", () => {
  it("POSTs /workspaces/self/box-update with the box bearer token", async () => {
    const seen: SeenRequest[] = [];
    const origin = await startServer(204, seen);
    const state = makeState(origin, TOKEN);

    const result = await runBlitz(state, ["box", "update"]);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("box update requested");
    expect(seen).toEqual([
      {
        method: "POST",
        url: "/workspaces/self/box-update",
        authorization: `Bearer ${TOKEN}`,
      },
    ]);
  });

  it("fails loudly when the control plane refuses", async () => {
    const seen: SeenRequest[] = [];
    const origin = await startServer(401, seen);
    const state = makeState(origin, TOKEN);

    const result = await runBlitz(state, ["box", "update"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("http 401");
  });

  it("fails loudly with no origin or no credential", async () => {
    const noOrigin = await runBlitz(makeState(null, TOKEN), ["box", "update"]);
    expect(noOrigin.status).toBe(1);
    expect(noOrigin.stderr).toContain("no control-plane origin");

    const noCredential = await runBlitz(makeState("http://127.0.0.1:9", null), ["box", "update"]);
    expect(noCredential.status).toBe(1);
    expect(noCredential.stderr).toContain("no box credential");
  });

  it("rejects unknown box verbs and stray arguments", async () => {
    const state = makeState(null, null);
    const unknown = await runBlitz(state, ["box", "restart"]);
    expect(unknown.status).toBe(2);

    const extra = await runBlitz(state, ["box", "update", "now"]);
    expect(extra.status).toBe(2);
    expect(extra.stderr).toContain("update takes no arguments");
  });
});
