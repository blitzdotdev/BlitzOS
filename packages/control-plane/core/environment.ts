import {
  HttpError,
  isBoolean,
  isRecord,
  isString,
  type JsonValue,
} from "./http.js";
import type {
  WorkspaceEnvironment,
  WorkspaceEnvironmentResponse,
} from "./wire.js";

const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const ENVIRONMENT_MAX_KEYS = 50;
const ENVIRONMENT_MAX_BYTES = 8 * 1024;
const STARTUP_SCRIPT_MAX_BYTES = 64 * 1024;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function parseEnvironmentValue(value: JsonValue): WorkspaceEnvironment {
  if (!isRecord(value)) throw new Error("environment must be an object");
  const fields = Object.keys(value).sort();
  if (fields.join(",") !== "env,startupScript") {
    throw new Error("environment must contain only env and startupScript");
  }
  if (!isRecord(value.env)) throw new Error("environment.env must be an object");
  const entries = Object.entries(value.env);
  if (entries.length > ENVIRONMENT_MAX_KEYS) {
    throw new Error(`environment.env must have at most ${String(ENVIRONMENT_MAX_KEYS)} keys`);
  }
  const validated: Array<[string, string]> = [];
  let bytes = 0;
  for (const [key, candidate] of entries) {
    if (!ENVIRONMENT_KEY.test(key)) {
      throw new Error(`environment.env key ${key} is invalid`);
    }
    if (!isString(candidate)) {
      throw new Error(`environment.env.${key} must be a string`);
    }
    if (candidate.includes("\0")) {
      throw new Error(`environment.env.${key} must not contain NUL`);
    }
    bytes += byteLength(key) + byteLength(candidate);
    if (bytes > ENVIRONMENT_MAX_BYTES) {
      throw new Error(`environment.env must be at most ${String(ENVIRONMENT_MAX_BYTES)} UTF-8 bytes`);
    }
    validated.push([key, candidate]);
  }
  if (!(value.startupScript === null || isString(value.startupScript))) {
    throw new Error("environment.startupScript must be a string or null");
  }
  if (
    value.startupScript !== null
    && byteLength(value.startupScript) > STARTUP_SCRIPT_MAX_BYTES
  ) {
    throw new Error(
      `environment.startupScript must be at most ${String(STARTUP_SCRIPT_MAX_BYTES)} UTF-8 bytes`,
    );
  }
  return { env: Object.fromEntries(validated), startupScript: value.startupScript };
}

export function parseWorkspaceEnvironment(value: JsonValue): WorkspaceEnvironment {
  try {
    return parseEnvironmentValue(value);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "environment is invalid";
    throw new HttpError(400, message);
  }
}

/** Stored environment that no longer parses reads as "none configured". One
 * unreadable row must not take down the list route that projects every
 * workspace in the org. */
export function workspaceEnvironmentFromJson(
  value: string | null,
  reportError?: (code: string, error: Error) => void,
): WorkspaceEnvironment | null {
  if (value === null) return null;
  try {
    return parseEnvironmentValue(JSON.parse(value));
  } catch (caught) {
    const detail = caught instanceof Error ? caught.message : "unparseable";
    reportError?.(
      "workspace_environment_unreadable",
      new Error(`stored workspace environment is invalid: ${detail}`),
    );
    return null;
  }
}

export function workspaceEnvironmentJson(value: WorkspaceEnvironment): string {
  return JSON.stringify(value);
}

export function parseWorkspaceEnvironmentResponse(
  value: JsonValue,
): WorkspaceEnvironmentResponse {
  if (!isRecord(value)) throw new Error("workspace environment response must be an object");
  const fields = Object.keys(value).sort();
  if (fields.join(",") !== "env,filesReady,startupScript") {
    throw new Error("workspace environment response has unexpected fields");
  }
  if (value.env === undefined || value.startupScript === undefined) {
    throw new Error("workspace environment response is missing fields");
  }
  if (!isBoolean(value.filesReady)) {
    throw new Error("workspace environment response filesReady must be boolean");
  }
  const environment = parseEnvironmentValue({
    env: value.env,
    startupScript: value.startupScript,
  });
  return { ...environment, filesReady: value.filesReady };
}
