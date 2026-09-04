import type { BoxPayloadConfig } from "./box-payload.js";

/** The envelope `GET /workspaces/self/box-config` returns to the VM host.
 *
 * This crosses a runtime boundary: the producer is the control-plane Worker
 * and the consumer is the host-side updater bash/python emitted by
 * `core/bootstrap.ts` (`blitz-box-update`). Both are pinned to
 * `packages/schema/fixtures/box-config/`.
 *
 * `boxImageRef` is the deployment's current pin (`runtime.vars.boxImageRef`).
 * `controlPlaneOrigin` is the one origin the box gateway should trust; the
 * host rewrites `/var/lib/blitz/origin` on every poll when it differs, which
 * needs no restart because the gateway re-reads the file per request.
 * `updateRequested` is the per-workspace flag; image updates are request-gated
 * because replacing the container kills every process inside it. */
export interface BoxConfigResponse {
  boxImageRef: string;
  controlPlaneOrigin: string;
  updateRequested: boolean;
  payload?: BoxPayloadConfig | null;
}

/** What the host reports after an update attempt, in the order it tries:
 * `up-to-date` (the requested ref already runs, nothing replaced),
 * `unsupported` (a tarball https ref, which the updater cannot pull),
 * `pull-failed` (the pull failed; the old container was never touched),
 * `updated` (the new container runs), `rolled-back` (the new container did
 * not start and the old ref runs again), `start-failed` (neither started). */
export const BOX_UPDATE_OUTCOMES = [
  "updated",
  "up-to-date",
  "rolled-back",
  "pull-failed",
  "start-failed",
  "unsupported",
] as const;

export type BoxUpdateOutcome = (typeof BOX_UPDATE_OUTCOMES)[number];

/** The body of `POST /workspaces/self/box-update-result`: the host is the
 * producer (bash/python in the emitted updater), the control plane is the
 * consumer. The control plane clears the workspace's update flag and stores
 * `ref` on the row (`box_image_reported`) whatever the outcome, so a failed
 * attempt never leaves the flag re-triggering forever. */
export interface BoxUpdateResultRequest {
  ref: string;
  outcome: BoxUpdateOutcome;
}
