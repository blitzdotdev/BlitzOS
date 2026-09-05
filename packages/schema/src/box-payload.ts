import {
  isJsonArray,
  isJsonNumber,
  isJsonObject,
  isJsonString,
  type JsonValue,
} from "./json.js";

/** Payload-owned longrun services a manifest may ask the updater to restart.
 * Oneshots are updated as files and take effect at next boot; the base-owned
 * updater longrun cannot restart itself during a transaction. */
export const BOX_PAYLOAD_RESTART_SERVICES = [
  "box-credential",
  "cloudflared",
  "dockerd",
  "dufs",
  "gateway",
  "lody-bridge",
  "lody-daemon",
  "lody-projects",
  "lody-watchdog",
  "machine-stats",
  "remote-control",
  "sshd",
  "ttyd",
  "watch",
] as const;

export type BoxPayloadRestartService = (typeof BOX_PAYLOAD_RESTART_SERVICES)[number];

export interface BoxPayloadFile {
  path: string;
  sha256: string;
  mode: string;
}

export interface BoxPayloadArchive {
  url: string;
  sha256: string;
  bytes: number;
}

export interface BoxPayloadDaemonArchive extends BoxPayloadArchive {
  version: string;
  protocolVersion: number;
}

export type BoxPayloadRestart = Partial<Record<BoxPayloadRestartService, string[]>>;

/** The signed description of one in-place box payload release. The daemon is
 * absent when a release reuses the daemon already selected by the running
 * payload. Unknown object members are ignored for forward compatibility. */
export interface BoxPayloadManifest {
  version: string;
  createdAt: number;
  minUpdater: number;
  files: BoxPayloadFile[];
  archive: BoxPayloadArchive;
  daemon?: BoxPayloadDaemonArchive;
  restart: BoxPayloadRestart;
}

/** The payload pin added to `GET /workspaces/self/box-config`. It is optional
 * on the envelope because deployed control planes predate this additive
 * field; a present `null` means the deployment has no payload pin. */
export interface BoxPayloadConfig {
  version: string;
  manifestUrl: string;
}

export const BOX_PAYLOAD_OUTCOMES = [
  "booted",
  "applied",
  "deferred",
  "rolled-back",
  "unsupported",
  "fetch-failed",
  "verify-failed",
  "start-failed",
  "up-to-date",
] as const;

export type BoxPayloadOutcome = (typeof BOX_PAYLOAD_OUTCOMES)[number];

/** The updater's body for `POST /workspaces/self/payload-result`. Versions
 * identify the running unit after the attempt; deferred and failure detail
 * name the pin that is waiting or was attempted. */
export interface BoxPayloadResultRequest {
  version: string;
  daemonVersion: string;
  outcome: BoxPayloadOutcome;
  detail: string;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MODE_PATTERN = /^[0-7]{4}$/u;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const HTTP_URL_PATTERN = /^https?:\/\/[^/\s?#]+(?:[/?][^\s#]*)?$/u;

function invalid(field: string, requirement: string): never {
  throw new Error(`box-payload ${field} ${requirement}`);
}

function requiredObject(value: JsonValue | undefined, field: string): Record<string, JsonValue> {
  if (value === undefined || !isJsonObject(value)) invalid(field, "must be an object");
  return value;
}

function requiredArray(value: JsonValue | undefined, field: string): JsonValue[] {
  if (value === undefined || !isJsonArray(value)) invalid(field, "must be an array");
  return value;
}

function requiredString(value: JsonValue | undefined, field: string): string {
  if (value === undefined || !isJsonString(value)) invalid(field, "must be a string");
  return value;
}

function safePositiveInteger(value: JsonValue | undefined, field: string): number {
  if (
    value === undefined
    || !isJsonNumber(value)
    || !Number.isSafeInteger(value)
    || value < 1
  ) {
    invalid(field, "must be a positive safe integer");
  }
  return value;
}

function version(value: JsonValue | undefined, field: string): string {
  const parsed = requiredString(value, field);
  if (!VERSION_PATTERN.test(parsed)) invalid(field, "must be a version token");
  return parsed;
}

function sha256(value: JsonValue | undefined, field: string): string {
  const parsed = requiredString(value, field);
  if (!SHA256_PATTERN.test(parsed)) invalid(field, "must be 64 lowercase hexadecimal characters");
  return parsed;
}

function url(value: JsonValue | undefined, field: string): string {
  const parsed = requiredString(value, field);
  if (!HTTP_URL_PATTERN.test(parsed)) invalid(field, "must be an absolute http(s) URL");
  return parsed;
}

function payloadPath(value: JsonValue | undefined, field: string): string {
  const parsed = requiredString(value, field);
  const segments = parsed.split("/");
  if (
    !parsed.startsWith("rootfs/")
    || segments.length < 2
    || segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    invalid(field, "must be a relative path under rootfs/ without dot segments");
  }
  return parsed;
}

function archive(value: JsonValue | undefined, field: string): BoxPayloadArchive {
  const parsed = requiredObject(value, field);
  return {
    url: url(parsed.url, `${field}.url`),
    sha256: sha256(parsed.sha256, `${field}.sha256`),
    bytes: safePositiveInteger(parsed.bytes, `${field}.bytes`),
  };
}

function file(value: JsonValue, index: number): BoxPayloadFile {
  const field = `manifest.files[${index}]`;
  const parsed = requiredObject(value, field);
  const mode = requiredString(parsed.mode, `${field}.mode`);
  if (!MODE_PATTERN.test(mode)) invalid(`${field}.mode`, "must be a four-character octal string");
  return {
    path: payloadPath(parsed.path, `${field}.path`),
    sha256: sha256(parsed.sha256, `${field}.sha256`),
    mode,
  };
}

function restartService(value: string): BoxPayloadRestartService {
  const service = BOX_PAYLOAD_RESTART_SERVICES.find((candidate) => candidate === value);
  if (service === undefined) invalid("manifest.restart service", `is unknown: ${value}`);
  return service;
}

function restart(value: JsonValue | undefined) {
  const parsed = requiredObject(value, "manifest.restart");
  const result: BoxPayloadRestart = {};
  for (const [serviceName, dependenciesValue] of Object.entries(parsed)) {
    const service = restartService(serviceName);
    const dependencies = requiredArray(
      dependenciesValue,
      `manifest.restart.${serviceName}`,
    ).map((dependency, index) => payloadPath(
      dependency,
      `manifest.restart.${serviceName}[${index}]`,
    ));
    result[service] = dependencies;
  }
  return result;
}

/** Parse untrusted JSON at the manifest boundary. `minUpdater` validity is
 * deliberately separate from support: every positive version is valid, and
 * the updater reports `unsupported` when the parsed value exceeds its own. */
export function parseBoxPayloadManifest(value: JsonValue): BoxPayloadManifest {
  const parsed = requiredObject(value, "manifest");
  const filesValue = requiredArray(parsed.files, "manifest.files");
  if (filesValue.length === 0) invalid("manifest.files", "must not be empty");

  const daemonValue = parsed.daemon;
  const daemonObject = daemonValue === undefined
    ? undefined
    : requiredObject(daemonValue, "manifest.daemon");
  const daemon = daemonObject === undefined
    ? undefined
    : {
        ...archive(daemonObject, "manifest.daemon"),
        version: version(daemonObject.version, "manifest.daemon.version"),
        protocolVersion: safePositiveInteger(
          daemonObject.protocolVersion,
          "manifest.daemon.protocolVersion",
        ),
      };

  const manifest: BoxPayloadManifest = {
    version: version(parsed.version, "manifest.version"),
    createdAt: safePositiveInteger(parsed.createdAt, "manifest.createdAt"),
    minUpdater: safePositiveInteger(parsed.minUpdater, "manifest.minUpdater"),
    files: filesValue.map(file),
    archive: archive(parsed.archive, "manifest.archive"),
    restart: restart(parsed.restart),
  };
  if (daemon !== undefined) manifest.daemon = daemon;
  return manifest;
}

/** Parse the updater's report body. Unknown members are tolerated so a newer
 * updater can report additional diagnostics to an older control plane. */
export function parseBoxPayloadResultRequest(value: JsonValue): BoxPayloadResultRequest {
  const parsed = requiredObject(value, "payload-result");
  const outcomeValue = requiredString(parsed.outcome, "payload-result.outcome");
  const outcome = BOX_PAYLOAD_OUTCOMES.find((candidate) => candidate === outcomeValue);
  if (outcome === undefined) {
    invalid("payload-result.outcome", `must be one of ${BOX_PAYLOAD_OUTCOMES.join(", ")}`);
  }
  return {
    version: version(parsed.version, "payload-result.version"),
    daemonVersion: version(parsed.daemonVersion, "payload-result.daemonVersion"),
    outcome,
    detail: requiredString(parsed.detail, "payload-result.detail"),
  };
}
