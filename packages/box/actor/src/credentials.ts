import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Provider } from "./types.js";

const execFileAsync = promisify(execFile);

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
interface JsonObject { [key: string]: JsonValue }

export interface WorkspaceEnvironmentState {
  env: Record<string, string>;
  startupScript: string | null;
  filesReady: boolean;
}

function isObject<Value>(value: Value): value is Value & JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString<Value>(value: Value): value is Value & string {
  return typeof value === "string";
}

function isBoolean<Value>(value: Value): value is Value & boolean {
  return typeof value === "boolean";
}

export function parseWorkspaceEnvironmentState(source: string): WorkspaceEnvironmentState {
  let value: JsonValue;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("workspace environment state is invalid JSON");
  }
  if (!isObject(value)) throw new Error("workspace environment state must be an object");
  if (Object.keys(value).sort().join(",") !== "env,filesReady,startupScript") {
    throw new Error("workspace environment state has unexpected fields");
  }
  if (!isObject(value.env)) throw new Error("workspace environment env must be an object");
  const entries = Object.entries(value.env);
  if (entries.length > 50) throw new Error("workspace environment has too many keys");
  const validated: Array<[string, string]> = [];
  let bytes = 0;
  for (const [name, candidate] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || !isString(candidate)) {
      throw new Error("workspace environment contains an invalid variable");
    }
    if (candidate.includes("\0")) {
      throw new Error("workspace environment contains NUL");
    }
    bytes += Buffer.byteLength(name) + Buffer.byteLength(candidate);
    if (bytes > 8 * 1024) throw new Error("workspace environment is too large");
    validated.push([name, candidate]);
  }
  if (!(value.startupScript === null || isString(value.startupScript))) {
    throw new Error("workspace environment startup script is invalid");
  }
  if (value.startupScript !== null && Buffer.byteLength(value.startupScript) > 64 * 1024) {
    throw new Error("workspace environment startup script is too large");
  }
  if (!isBoolean(value.filesReady)) {
    throw new Error("workspace environment filesReady is invalid");
  }
  return {
    env: Object.fromEntries(validated),
    startupScript: value.startupScript,
    filesReady: value.filesReady,
  };
}

export class CredentialSource {
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

  public async environment(): Promise<NodeJS.ProcessEnv> {
    const statePath = join(this.stateDir, "env", "environment.json");
    let configured: WorkspaceEnvironmentState | null = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const source = await readFile(statePath, "utf8").catch(() => null);
      if (source !== null) {
        configured = parseWorkspaceEnvironmentState(source);
        break;
      }
      if (attempt === 0) {
        const enrolled = await access(join(this.stateDir, "origin"), constants.R_OK)
          .then(() => true)
          .catch(() => false);
        if (!enrolled) return { ...process.env };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (configured === null) throw new Error("workspace environment state is unavailable");
    return { ...process.env, ...configured.env };
  }
}
