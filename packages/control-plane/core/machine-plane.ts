/**
 * The routes a machine's box credential may authenticate on.
 *
 * An agent inside a box gets a machine API: find the workspaces its member can
 * see, and provision, start, stop, recreate or destroy the machines in them.
 * It then reaches the machine over SSH with the details `WorkspaceView.ssh`
 * already carries. Nothing else — not workspace lifecycle, not members, org
 * settings or billing, and nothing on the OAuth device flow.
 *
 * WHY AN ALLOWLIST AND NOT A DENYLIST. `requirePrincipal` is the single door
 * every session route shares, so widening it widens ALL of them at once. An
 * earlier cut of this change did exactly that, and the consequence was
 * concrete: `POST /oauth/device/approve` became reachable from a box, which
 * would let an agent claim a device authorization a person had started. An
 * allowlist makes that structurally impossible rather than merely
 * unattractive — a route added tomorrow is closed to the machine plane until
 * somebody names it here.
 *
 * The `/workspaces/self/*` routes are NOT in this table and do not need to be:
 * they authenticate through `boxCaller` directly and never consult
 * `requirePrincipal`.
 */

/** Read-only discovery: which workspaces exist, and what is in them. */
const WORKSPACE_LIST = /^\/workspaces$/;
const WORKSPACE_ONE = /^\/workspaces\/[^/]+$/;
const MACHINE_TYPES = /^\/machine-types$/;

/**
 * Machine lifecycle. `machine-type` is deliberately absent: changing a type
 * destroys the VM and re-provisions it at a different price, which is a
 * spending decision rather than a machine an agent is driving.
 */
const MACHINE_VERB = /^\/machines\/[^/]+\/(provision|start|stop|recreate)$/;
const MACHINE_ONE = /^\/machines\/[^/]+$/;

/**
 * Segments that sit in the `:id` slot but name a route rather than a
 * workspace. `GET /workspaces/history` is the deleted-workspace list, so it is
 * named here and refused: the allowlist grants the two reads it says it
 * grants, not everything that happens to look like one.
 */
const RESERVED_WORKSPACE_SEGMENTS = new Set(["history"]);

export function machinePlaneAllows(method: string, pathname: string): boolean {
  const verb = method.toUpperCase();
  if (verb === "GET") {
    if (WORKSPACE_LIST.test(pathname) || MACHINE_TYPES.test(pathname)) return true;
    if (WORKSPACE_ONE.test(pathname)) {
      return !RESERVED_WORKSPACE_SEGMENTS.has(pathname.slice("/workspaces/".length));
    }
    return false;
  }
  if (verb === "POST") return MACHINE_VERB.test(pathname);
  if (verb === "DELETE") return MACHINE_ONE.test(pathname);
  return false;
}
