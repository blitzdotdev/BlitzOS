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
 * `updateRequested` is the per-machine flag; image updates are request-gated
 * because replacing the container kills every process inside it.
 *
 * `boxImageSha256` is the digest of the whole image archive, and it is what
 * makes the host's verification as strong as the first boot's. Without it the
 * updater could only check the archive against the digest the MANIFEST
 * declares, which is self-certifying: whoever serves the manifest serves the
 * digest beside it. This one arrives from the control plane instead, over a
 * separate connection, exactly as the bootstrap's baked-in `BOX_IMAGE_SHA256`
 * does. Empty under a registry pin, where the ref carries its own digest and
 * docker checks it. */
export interface BoxConfigResponse {
  boxImageRef: string;
  boxImageSha256: string;
  controlPlaneOrigin: string;
  updateRequested: boolean;
}

/** What the host reports after an update attempt.
 *
 * Acquiring the image comes first and never touches the running container, so
 * every acquire verdict means "nothing changed": `pull-failed` (a registry
 * pull failed), `download-failed` (a manifest or archive part did not arrive),
 * `digest-mismatch` (a part or the whole archive failed its SHA-256 —
 * a corrupt or tampered archive, never loaded), `load-failed` (the archive
 * verified but `docker load` refused it).
 *
 * The rest describe the swap: `up-to-date` (the wanted image already runs,
 * nothing replaced), `updated` (the new container runs), `rolled-back` (the
 * new container did not start and the old image runs again), `start-failed`
 * (neither started), `unsupported` (this host's updater cannot install the
 * ref at all — an https ref that is not a manifest, or any https ref on a host
 * whose updater predates the manifest branch). */
export const BOX_UPDATE_OUTCOMES = [
  "updated",
  "up-to-date",
  "rolled-back",
  "pull-failed",
  "download-failed",
  "digest-mismatch",
  "load-failed",
  "start-failed",
  "unsupported",
] as const;

export type BoxUpdateOutcome = (typeof BOX_UPDATE_OUTCOMES)[number];

/** The body of `POST /workspaces/self/box-update-result`: the host is the
 * producer (bash/python in the emitted updater), the control plane is the
 * consumer. The control plane clears the machine's update flag and stores
 * `ref` on the row (`box_image_reported`) whatever the outcome, so a failed
 * attempt never leaves the flag re-triggering forever.
 *
 * `tag` is the CONCRETE image the `blitz-box` container runs once the attempt
 * has settled — the tag under an R2 manifest ref, the ref itself under a
 * registry ref, and the OLD image whenever the attempt left the container
 * alone. It is optional because a host emitted before the manifest branch
 * never sends it; `ref` alone cannot answer "is an update available" under a
 * manifest ref, whose URL is identical across rebakes while the tag inside it
 * moves. */
export interface BoxUpdateResultRequest {
  ref: string;
  outcome: BoxUpdateOutcome;
  tag?: string;
}
