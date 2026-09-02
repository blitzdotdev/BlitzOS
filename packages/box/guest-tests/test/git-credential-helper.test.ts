import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `/usr/local/libexec/blitz-git-credential` is the whole of git auth on a box:
 * /etc/gitconfig points `credential "https://github.com"` at it, and it mints
 * a token through the control plane's agent credentials API with a bearer from
 * `blitz-cred api-token`. These drive the real script — real curl, real jq —
 * against a stand-in control plane, with only blitz-cred stubbed, because the
 * contract that matters is the bytes on stdout: git parses them as credential
 * attributes, and any failure must answer nothing at exit 0 so git falls
 * through to anonymous access instead of failing a public clone.
 */

const scriptPath = fileURLToPath(
  new URL("../../rootfs/usr/local/libexec/blitz-git-credential", import.meta.url),
);

// jq is in the box image (Dockerfile pins it) but not on every dev machine.
// The paths that never reach jq still run everywhere.
const hasJq = spawnSync("jq", ["--version"]).status === 0;

interface HelperBox {
  stateDir: string;
  binDir: string;
}

const boxes: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const directory of boxes.splice(0)) rmSync(directory, { recursive: true, force: true });
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function makeHelperBox(origin: string | null, credStub?: string): HelperBox {
  const stateDir = mkdtempSync(join(tmpdir(), "git-cred-"));
  boxes.push(stateDir);
  if (origin !== null) writeFileSync(join(stateDir, "origin"), `${origin}\n`);
  const binDir = join(stateDir, "stub-bin");
  mkdirSync(binDir);
  // The one moving part the script is allowed to lean on: a bearer printer.
  // It must be asked for `api-token` and nothing else.
  writeFileSync(
    join(binDir, "blitz-cred"),
    credStub ?? '#!/bin/sh\n[ "$1" = api-token ] || exit 2\nprintf \'machine-bearer\\n\'\n',
  );
  chmodSync(join(binDir, "blitz-cred"), 0o755);
  return { stateDir, binDir };
}

interface HelperResult {
  status: number | null;
  stdout: string;
}

function runHelper(box: HelperBox, action: string, input: string): Promise<HelperResult> {
  return new Promise((resolve) => {
    const child = spawn("sh", [scriptPath, action], {
      env: {
        ...process.env,
        PATH: `${box.binDir}:${process.env.PATH ?? ""}`,
        BLITZ_STATE_DIR: box.stateDir,
      },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.on("close", (status) => resolve({ status, stdout }));
    child.stdin.end(input);
  });
}

interface Minted {
  authorization: string | undefined;
}

/** A stand-in control plane answering POST /agent/credentials/github/token. */
function mintServer(status: number, body: string, minted: Minted[]): Promise<string> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url !== "/agent/credentials/github/token" || req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }
    minted.push({ authorization: req.headers.authorization });
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  });
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

const githubGet = "protocol=https\nhost=github.com\npath=owner/repo.git\n\n";

describe("blitz-git-credential", () => {
  it.skipIf(!hasJq)("answers get for github.com with the minted token", async () => {
    const minted: Minted[] = [];
    const origin = await mintServer(200, '{"token":"ghs-mint","scope":"connection"}', minted);
    const box = makeHelperBox(origin);

    const result = await runHelper(box, "get", githubGet);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("username=x-access-token\npassword=ghs-mint\n\n");
    expect(minted).toHaveLength(1);
    expect(minted[0]?.authorization).toBe("Bearer machine-bearer");
  });

  it("answers nothing for a host that is not github.com", async () => {
    const minted: Minted[] = [];
    const origin = await mintServer(200, '{"token":"ghs-mint"}', minted);
    const box = makeHelperBox(origin);

    const result = await runHelper(box, "get", "protocol=https\nhost=gitlab.com\n\n");

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(minted).toHaveLength(0);
  });

  it("acknowledges store and erase without minting anything", async () => {
    const minted: Minted[] = [];
    const origin = await mintServer(200, '{"token":"ghs-mint"}', minted);
    const box = makeHelperBox(origin);

    for (const action of ["store", "erase"]) {
      const result = await runHelper(box, action, githubGet);
      expect(result.status, action).toBe(0);
      expect(result.stdout, action).toBe("");
    }
    expect(minted).toHaveLength(0);
  });

  it.skipIf(!hasJq)("a refusal answers nothing, so git falls through to anonymous", async () => {
    // Not connected: the control plane files a request and answers 404 with no
    // token. A public clone must still work, so the helper stays silent.
    const minted: Minted[] = [];
    const origin = await mintServer(404, '{"error":"not_connected","request_id":"req-1"}', minted);
    const box = makeHelperBox(origin);

    const result = await runHelper(box, "get", githubGet);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(minted).toHaveLength(1);
  });

  it.skipIf(!hasJq)("refuses a token it cannot print as one protocol line", async () => {
    // A value with a newline would forge a second credential attribute.
    const minted: Minted[] = [];
    const origin = await mintServer(200, '{"token":"bad\\nvalue"}', minted);
    const box = makeHelperBox(origin);

    const result = await runHelper(box, "get", githubGet);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("answers nothing when the box has no origin on disk", async () => {
    const box = makeHelperBox(null);
    const result = await runHelper(box, "get", githubGet);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("answers nothing when blitz-cred cannot produce a bearer", async () => {
    const minted: Minted[] = [];
    const origin = await mintServer(200, '{"token":"ghs-mint"}', minted);
    const box = makeHelperBox(origin, "#!/bin/sh\nexit 1\n");

    const result = await runHelper(box, "get", githubGet);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(minted).toHaveLength(0);
  });

  it("answers nothing on an unreachable control plane", async () => {
    // Nothing listens on this port, so curl itself fails.
    const box = makeHelperBox("http://127.0.0.1:1");
    const result = await runHelper(box, "get", githubGet);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });
});
