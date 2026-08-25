import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { isNumber, isString } from "./type-guards.js";
import type { Provider } from "./types.js";

const execFileAsync = promisify(execFile);

/** What `promisify(execFile)` rejects with: the child's own streams, attached
 * to an Error. */
interface ExecFailure {
  stderr?: Buffer | string;
}

interface ExecStatusFailure {
  code?: string | number;
}

export type HarnessAuthStatus = "signed-in" | "signed-out" | "unknown";

export interface AuthStatusCommandOptions {
  timeout: number;
  env: NodeJS.ProcessEnv;
}

export type AuthStatusRunner = (
  file: string,
  args: string[],
  options: AuthStatusCommandOptions,
) => Promise<void>;

function execFailure(error: Error): ExecFailure {
  // SAFETY: promisify(execFile) attaches the child's captured streams to the
  // rejected Error. `stderr` is declared optional and read defensively, so any
  // other rejection shape simply yields no reason.
  return error as ExecFailure;
}

function execStatusFailure(error: Error): ExecStatusFailure {
  // SAFETY: execFile attaches its process exit code to Error rejections. The
  // field stays optional and is validated before it affects auth state.
  return error as ExecStatusFailure;
}

const runAuthStatusCommand: AuthStatusRunner = async (file, args, options) => {
  await execFileAsync(file, args, options);
};

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

/** One statement of a broker-written export file, kept in the order the shell
 * would have run it. */
interface CredentialDirective {
  name: string;
  value: string;
}

/** What `shellQuote` in packages/broker/internal/workspace/cp.go emits for a
 * literal quote inside a single-quoted word: close, quote a quote, reopen. */
const SHELL_QUOTE_ESCAPE = "'\"'\"'";

/** Linux caps one `NAME=value` string in an execve environment at
 * MAX_ARG_STRLEN (32 pages, 128 KiB). A value over that limit cannot be
 * delivered at all, so passing it through would fail the whole spawn instead
 * of one variable. */
const CREDENTIAL_MAX_ENTRY_BYTES = 128 * 1024;

/**
 * The statements in one `creds/env.d/*.sh` file, in file order.
 *
 * Written by the Go broker and read by /etc/profile.d/blitz-creds.sh, so this
 * decodes exactly the one form that writer emits — `export NAME='value'` with
 * every `'` escaped as `'"'"'` — and nothing else. Anything it does not
 * recognise is dropped at the next line boundary rather than guessed at: these
 * bytes become the environment of an agent, and a half-understood assignment
 * is a worse answer than a missing one.
 *
 * Skipping is per statement, not per file, because the writer replaces the
 * whole file atomically (`atomicfile.Write`) — a line this cannot read means
 * the two sides have drifted, not that a read was torn, and dropping the file
 * over it would retract every variable in it. A quoted value is consumed
 * whole, newlines included, so a skip resumes on a real statement boundary for
 * every file the broker actually produces.
 */
export function parseCredentialExportFile(source: string): CredentialDirective[] {
  const directives: CredentialDirective[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const read = readCredentialDirective(source, cursor);
    if (read !== null) {
      directives.push(read.directive);
      cursor = read.next;
      continue;
    }
    const newline = source.indexOf("\n", cursor);
    if (newline === -1) break;
    cursor = newline + 1;
  }
  return directives;
}

/** Names are checked against {@link ENVIRONMENT_KEY} because the Go writer
 * validates them with the identical pattern (`environmentNamePattern`): a name
 * outside it never came from the broker. */
function readCredentialDirective(
  source: string,
  start: number,
): { directive: CredentialDirective; next: number } | null {
  if (!source.startsWith("export ", start)) return null;
  const assign = source.indexOf("=", start);
  if (assign === -1 || source[assign + 1] !== "'") return null;
  const name = source.slice(start + "export ".length, assign);
  if (!ENVIRONMENT_KEY.test(name)) return null;
  let cursor = assign + 2;
  let value = "";
  for (;;) {
    const quote = source.indexOf("'", cursor);
    if (quote === -1) return null;
    value += source.slice(cursor, quote);
    if (source.startsWith(SHELL_QUOTE_ESCAPE, quote)) {
      // Greedy on purpose: the writer leaves no bare quote inside the word, so
      // this sequence is always the escape and never a close followed by data.
      value += "'";
      cursor = quote + SHELL_QUOTE_ESCAPE.length;
      continue;
    }
    const end = quote + 1;
    if (end !== source.length && source[end] !== "\n") return null;
    if (value.includes("\0")) return null;
    if (Buffer.byteLength(name) + 1 + Buffer.byteLength(value) > CREDENTIAL_MAX_ENTRY_BYTES) return null;
    return { directive: { name, value }, next: end + 1 };
  }
}

export class CredentialSource {
  private lastEnvironment: Record<string, string> = {};
  private environmentWaited = false;

  public constructor(
    private readonly stateDir: string,
    private readonly authStatusRunner: AuthStatusRunner = runAuthStatusCommand,
  ) {}

  public async authStatus(provider: Provider): Promise<HarnessAuthStatus> {
    try {
      await access(join(this.stateDir, "broker.json"), constants.R_OK);
      // Broker status is deliberately deferred. A stored broker token is not
      // proof that it is unexpired or refreshable, so do not claim signed in.
      return "unknown";
    } catch (brokerError) {
      if (!(brokerError instanceof Error) || execStatusFailure(brokerError).code !== "ENOENT") {
        return "unknown";
      }
    }

    // A standalone/self-hosted box keeps the vendor's own login files, so the
    // pinned official status commands are authoritative in this mode.
    const command = provider === "claude"
      ? { file: "/opt/blitz/npm/bin/claude", args: ["auth", "status"] }
      : { file: "/opt/blitz/npm/bin/codex", args: ["login", "status"] };
    try {
      await this.authStatusRunner(command.file, command.args, {
        timeout: 10_000,
        env: { ...process.env, HOME: "/var/lib/blitz/home" },
      });
      return "signed-in";
    } catch (statusError) {
      if (!(statusError instanceof Error)) return "unknown";
      return isNumber(execStatusFailure(statusError).code) ? "signed-out" : "unknown";
    }
  }

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
    if (stdout.length === 0 || stdout.length > 1_048_576) {
      throw new Error("broker returned an invalid token");
    }
    return parseToken(stdout);
  }

  /** The agent's environment for one turn. Workspace variables are optional
   * configuration, so every failure path here degrades to the actor's own
   * environment: an enrolled box whose broker has not written the file yet, a
   * box with nothing configured, and a torn or corrupt file all still run the
   * prompt. This never rejects — a prompt must not fail over env.
   *
   * No connection secret is here. The agent pulls one when it needs one
   * (`blitz-cred get <provider>`), so a turn carries only the workspace's own
   * configured variables. The layering is the login shell's, reproduced: this
   * process's own environment underneath, then the workspace's configured
   * variables, then `creds/env.d/*.sh` applied in sorted filename order
   * exactly as the glob in /etc/profile.d/blitz-creds.sh expands it. Chat and
   * a terminal tab read the identical bytes in the identical order, so they
   * cannot disagree about what a variable holds. */
  public async environment(): Promise<NodeJS.ProcessEnv> {
    const configured = await this.workspaceVariables();
    const merged: NodeJS.ProcessEnv = { ...process.env, ...configured };
    for (const directive of await this.credentialDirectives()) {
      merged[directive.name] = directive.value;
    }
    return merged;
  }

  /** Every statement in `creds/env.d`, concatenated in glob order.
   *
   * A missing directory is the normal state of a box whose broker has not
   * written the workspace entry yet. It degrades to "no variables" rather than
   * failing the turn. */
  private async credentialDirectives(): Promise<CredentialDirective[]> {
    const directory = join(this.stateDir, "creds", "env.d");
    const entries = await readdir(directory).catch(() => null);
    if (entries === null) return [];
    // Node sorts by UTF-16 code unit, which is byte order for the ASCII file
    // names the broker writes — the same order the shell's glob produces.
    const files = entries.filter((entry) => entry.endsWith(".sh")).sort();
    const directives: CredentialDirective[] = [];
    for (const file of files) {
      const source = await readFile(join(directory, file), "utf8").catch(() => null);
      if (source !== null) directives.push(...parseCredentialExportFile(source));
    }
    return directives;
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
