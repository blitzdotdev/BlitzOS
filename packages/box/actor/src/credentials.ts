import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Provider } from "./types.js";

const execFileAsync = promisify(execFile);

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

function isString<Value>(value: Value): value is Value & string {
  return typeof value === "string";
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
      return null;
    }
    const { stdout } = await execFileAsync("blitz-cred", ["token", provider], {
      encoding: "buffer",
      maxBuffer: 1_048_576,
      env: { ...process.env, BLITZ_STATE_DIR: this.stateDir },
    });
    if (stdout.length === 0 || stdout.length > 1_048_576) {
      throw new Error("broker returned an invalid token");
    }
    return stdout.toString("utf8");
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
