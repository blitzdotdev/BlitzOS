/** The local Worker copy of the box-payload v1 contract.
 *
 * Split from `core/wire.ts` to keep that public surface below the 700-line
 * house-rule threshold. `core/wire.ts` re-exports every name, so consumers do
 * not know about the seam. The mirror is
 * `packages/schema/src/box-payload.ts`, pinned by `test/wire-drift.test.ts`. */

/** The base-image s6 services a payload manifest may ask the updater to
 * restart. This list is also pinned to the rootfs service directory. */
export const BOX_PAYLOAD_RESTART_SERVICES = [
  "cgroups",
  "cloudflared",
  "dockerd",
  "dufs",
  "enroll",
  "gateway",
  "init-state",
  "lody-bridge",
  "lody-daemon",
  "lody-projects",
  "lody-watchdog",
  "machine-stats",
  "register",
  "remote-control",
  "rules",
  "sshd",
  "ttyd",
  "user",
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

export interface BoxPayloadManifest {
  version: string;
  createdAt: number;
  minUpdater: number;
  files: BoxPayloadFile[];
  archive: BoxPayloadArchive;
  daemon?: BoxPayloadDaemonArchive;
  restart: BoxPayloadRestart;
}

export interface BoxPayloadConfig {
  version: string;
  manifestUrl: string;
}

export const BOX_PAYLOAD_OUTCOMES = [
  "applied",
  "rolled-back",
  "unsupported",
  "fetch-failed",
  "verify-failed",
  "start-failed",
  "up-to-date",
] as const;

export type BoxPayloadOutcome = (typeof BOX_PAYLOAD_OUTCOMES)[number];

export interface BoxPayloadResultRequest {
  version: string;
  daemonVersion: string;
  outcome: BoxPayloadOutcome;
  detail: string;
}
