import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { isString } from "./type-guards.js";
import type { Provider } from "./types.js";

const execFileAsync = promisify(execFile);

/** What `promisify(execFile)` rejects with: the child's own streams, attached
 * to an Error. */
interface ExecFailure {
  stderr?: Buffer | string;
}

function execFailure(error: Error): ExecFailure {
  // SAFETY: promisify(execFile) attaches the child's captured streams to the
  // rejected Error. `stderr` is declared optional and read defensively, so any
  // other rejection shape simply yields no reason.
  return error as ExecFailure;
}

/** One short line of the broker's own words, for a log.
 *
 * `blitz-cred token` writes exactly one thing to stdout — the token — and every
 * refusal to stderr, so nothing minted can be routed here. Without it, a member
 * who has to log in again and a box wired to a harness the broker will not mint
 * for produce the identical, useless "Command failed".
 */
function brokerReason(failure: ExecFailure): string {
  const stderr = failure.stderr;
  const text = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : isString(stderr) ? stderr : "";
  const line = text
    .split("\n")
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0)
    .at(-1);
  if (line === undefined) return "";
  // Bounded, and stripped of control characters: this reaches a log line and a
  // remote must not be able to forge one or repaint a terminal through it.
  return [...line]
    .filter((character) => character >= " " && character !== "\u007F")
    .join("")
    .slice(0, 200);
}

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
interface JsonObject { [key: string]: JsonValue }

/** Wait for the broker's first environment fetch, but only once. The file is
 * written within a second of boot and then stays, so a prompt that arrives
 * before it exists waits briefly; every later prompt reads through. */
const ENVIRONMENT_WAIT_ATTEMPTS = 50;
const ENVIRONMENT_WAIT_INTERVAL_MS = 100;
/** Mirrors the control plane's `env` limits. The three runtimes that carry
 * this payload cannot share a module — core/ may only import relatively — so
 * `schema/fixtures/workspace-environment/` is what keeps the numbers equal. */
const ENVIRONMENT_MAX_KEYS = 50;
const ENVIRONMENT_MAX_BYTES = 8 * 1024;
const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function isObject<Value>(value: Value): value is Value & JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses only what the agent uses. The startup script and the files-ready
 * flag belong to the broker, which validates and acts on them; re-checking
 * fields we then discard bought a third copy of that validator and nothing
 * else. */
export function parseWorkspaceEnvironmentVariables(source: string): Record<string, string> {
  let value: JsonValue;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("workspace environment state is invalid JSON");
  }
  if (!isObject(value)) throw new Error("workspace environment state must be an object");
  if (!isObject(value.env)) throw new Error("workspace environment env must be an object");
  const entries = Object.entries(value.env);
  if (entries.length > ENVIRONMENT_MAX_KEYS) {
    throw new Error("workspace environment has too many keys");
  }
  const validated: Array<[string, string]> = [];
  let bytes = 0;
  for (const [name, candidate] of entries) {
    if (!ENVIRONMENT_KEY.test(name) || !isString(candidate)) {
      throw new Error("workspace environment contains an invalid variable");
    }
    if (candidate.includes("\0")) {
      throw new Error("workspace environment contains NUL");
    }
    bytes += Buffer.byteLength(name) + Buffer.byteLength(candidate);
    if (bytes > ENVIRONMENT_MAX_BYTES) throw new Error("workspace environment is too large");
    validated.push([name, candidate]);
  }
  return Object.fromEntries(validated);
}

export class CredentialSource {
  private lastEnvironment: Record<string, string> = {};
  private environmentWaited = false;

  public constructor(private readonly stateDir: string) {}

  public async token(provider: Provider): Promise<string | null> {
    try {
      await access(join(this.stateDir, "broker.json"), constants.R_OK);
    } catch {
      // No broker is configured for this workspace. That is a supported state,
      // not a failure: the turn runs signed out.
      return null;
    }
    let stdout: Buffer;
    try {
      ({ stdout } = await execFileAsync("blitz-cred", ["token", provider], {
        encoding: "buffer",
        maxBuffer: 1_048_576,
        env: { ...process.env, BLITZ_STATE_DIR: this.stateDir },
      }));
    } catch (error) {
      const reason = error instanceof Error ? brokerReason(execFailure(error)) : "";
      throw new Error(reason ? `broker mint failed: ${reason}` : "broker mint failed");
    }
    // Size is already owned on both sides: execFile's maxBuffer above kills
    // and rejects any child whose stdout exceeds it, and parseToken refuses
    // an empty line.
    return parseToken(stdout);
  }

  /** The agent's environment for one turn. Workspace variables are optional
   * configuration, so every failure path here degrades to the actor's own
   * environment: an enrolled box whose broker has not written the file yet, a
   * box with nothing configured, and a torn or corrupt file all still run the
   * prompt. This never rejects — a prompt must not fail over env. */
  public async environment(): Promise<NodeJS.ProcessEnv> {
    const configured = await this.workspaceVariables();
    return { ...process.env, ...configured };
  }

  private async workspaceVariables(): Promise<Record<string, string>> {
    const statePath = join(this.stateDir, "env", "environment.json");
    // Probe enrollment the same way token() does. `origin` is written by the
    // enroll step; broker.json is what says a broker is actually running and
    // therefore that a fetch is on its way.
    const attempts = this.environmentWaited || !(await this.brokerPresent())
      ? 1
      : ENVIRONMENT_WAIT_ATTEMPTS;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, ENVIRONMENT_WAIT_INTERVAL_MS));
      }
      const source = await readFile(statePath, "utf8").catch(() => null);
      if (source === null) continue;
      try {
        this.lastEnvironment = parseWorkspaceEnvironmentVariables(source);
      } catch {
        // Keep the last good copy rather than dropping configuration because
        // one read caught a half-written file.
        break;
      }
      return this.lastEnvironment;
    }
    this.environmentWaited = true;
    return this.lastEnvironment;
  }

  private brokerPresent(): Promise<boolean> {
    return access(join(this.stateDir, "broker.json"), constants.R_OK)
      .then(() => true)
      .catch(() => false);
  }
}

/** The broker's stdout, parsed into a token.
 *
 * The TRIM is load-bearing, not tidiness. The broker prints the minted token
 * with `fmt.Fprintln` (packages/broker/cmd/blitz-broker/main.go), so the bytes
 * that arrive here always end in a newline, and every hop between there and
 * here passes them through verbatim. The terminal shim survives it because
 * `$(…)` strips trailing newlines; the chat path does not — the value goes
 * straight into CLAUDE_CODE_OAUTH_TOKEN, and a token with a newline in it is
 * rejected by the vendor on every single request. A signed-in workspace whose
 * chat says "not logged in" is exactly that newline.
 *
 * Control characters are then a REFUSAL rather than something else to strip.
 * A token is one opaque line; anything else on this channel means the broker
 * sent something that is not a token, and quietly repairing it would deliver
 * whichever fragment survived the repair.
 */
function parseToken(stdout: Buffer): string {
  const token = stdout.toString("utf8").trim();
  if (token.length === 0 || [...token].some((character) => character < " " || character === "\u007F")) {
    throw new Error("broker returned an invalid token");
  }
  return token;
}
