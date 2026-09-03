/**
 * The daemon's own identity, read from `/lody/platform`
 * (plans/LODY-RUNTIME-DESIGN.md §1.2, §3.4, risk 4).
 *
 * `PlatformUser.id` is NOT a BlitzOS membership id. The local composition mints
 * a durable `local:<uuid>` user and one `lw_<uuid>` workspace into
 * `$LODY_DATA_DIR/workspace-catalog.json`
 * (`vendor/lody/packages/shared/src/node/local-workspace-catalog.ts`), and every
 * local write and access check runs against it
 * (`vendor/lody/packages/platform/src/local.ts:93`). Our auth contributes
 * display name, avatar and workspace title and nothing else; membership, roles
 * and sharing stay in D1 and reach Lody in phase 6 through the gateway ticket.
 *
 * The bridge serves the daemon's catalog file byte-for-byte, so the parser here
 * is a port of Lody's own
 * (`vendor/lody/apps/electron/src/main/local-platform-snapshot.ts`), with one
 * addition the Electron path gets from a different IPC call: the `machineId`.
 * Every RPC the browser sends is addressed to a machine, and the agent-config
 * bootstrap writes rows keyed by it, so it must arrive with the identity or
 * neither is usable.
 *
 * MEASURED DEVIATION from the design doc: §3.4 expected the machineId in
 * `run/daemon.json`. Against lody@0.88.1 that file carries only
 * `{ pid, socketPath, controlSocketPath, version, startedAt }` and the id lives
 * in the catalog's own `machine` block, so the catalog is the single source.
 */
import { isJsonArray, isJsonObject, isJsonString, parseJson, type JsonValue } from "@blitzos/schema";
import { boxGatewayFetch } from "../box-gateway-health.js";

/** The four fields Lody's own parser produces, plus the machine block. */
export interface LodyPlatformSnapshot {
  /** `local:<uuid>` — the daemon's durable local user. */
  userId: string;
  /** The daemon's machine, which is this box. */
  machineId: string;
  workspace: {
    /** `lw_<uuid>` */
    workspaceId: string;
    /** The daemon's own title ("Lody"); ours replaces it for display. */
    name: string;
    slug: string | null;
    role: string;
  };
}

/** Both prefixes are isolation boundaries upstream
 * (`vendor/lody/packages/platform/src/local.ts:21-28`): a cloud-mode peer
 * refuses a local-identity catalog and vice versa, so accepting an id without
 * its prefix would silently address the wrong plane. */
const LOCAL_USER_ID_PREFIX = "local:";
const LOCAL_WORKSPACE_ID_PREFIX = "lw_";

export class LodyPlatformSnapshotError extends Error {}

function requireString(value: JsonValue | undefined, what: string): string {
  if (value === undefined || !isJsonString(value) || value === "") {
    throw new LodyPlatformSnapshotError(`Lody catalog has no ${what}`);
  }
  return value;
}

/**
 * Parses the daemon's catalog into the snapshot the platform provider needs.
 *
 * Throws rather than returning null on a malformed catalog: the caller polls
 * this door until it settles (the daemon writes the file only after it
 * provisions its implicit workspace), and a snapshot that parsed to a partial
 * identity would put the whole runtime on the wrong `userId` — which the daemon
 * then rejects at dispatch, far from the cause.
 */
export function parseLodyPlatformSnapshot(decoded: JsonValue): LodyPlatformSnapshot {
  if (!isJsonObject(decoded)) {
    throw new LodyPlatformSnapshotError("Lody catalog must be an object");
  }

  const identity = decoded.identity;
  if (identity === undefined || !isJsonObject(identity)) {
    throw new LodyPlatformSnapshotError("Lody catalog is missing identity");
  }
  const userId = requireString(identity.userId, "local user id");
  if (!userId.startsWith(LOCAL_USER_ID_PREFIX)) {
    throw new LodyPlatformSnapshotError("Lody catalog has an invalid local user id");
  }

  const machine = decoded.machine;
  if (machine === undefined || !isJsonObject(machine)) {
    throw new LodyPlatformSnapshotError("Lody catalog is missing its machine block");
  }
  const machineId = requireString(machine.machineId, "machine id");

  const workspaces = decoded.workspaces;
  if (workspaces === undefined || !isJsonArray(workspaces)) {
    throw new LodyPlatformSnapshotError("Lody catalog is missing workspaces");
  }
  // Exactly one active workspace, as upstream requires: the local composition
  // provisions a single implicit workspace and `createLocalWorkspaces` rejects
  // activating any other id.
  const active = workspaces.filter(
    (entry) => isJsonObject(entry) && entry.state === "active",
  );
  if (active.length !== 1) {
    throw new LodyPlatformSnapshotError(
      `Lody catalog must contain exactly one active workspace; found ${active.length}`,
    );
  }
  const workspace = active[0];
  if (workspace === undefined || !isJsonObject(workspace)) {
    throw new LodyPlatformSnapshotError("Lody catalog has an invalid active workspace");
  }
  const workspaceId = requireString(workspace.workspaceId, "workspace id");
  if (!workspaceId.startsWith(LOCAL_WORKSPACE_ID_PREFIX)) {
    throw new LodyPlatformSnapshotError("Lody catalog has an invalid workspace id");
  }
  const slugValue = workspace.slug;
  if (slugValue !== null && slugValue !== undefined && !isJsonString(slugValue)) {
    throw new LodyPlatformSnapshotError("Lody catalog has an invalid workspace slug");
  }

  return {
    userId,
    machineId,
    workspace: {
      workspaceId,
      name: requireString(workspace.name, "workspace name"),
      slug: slugValue === undefined || slugValue === null ? null : slugValue,
      role: requireString(workspace.role, "workspace role"),
    },
  };
}

/** `LOCAL_WORKSPACE_FALLBACK_SLUG`
 * (`vendor/lody/packages/components/src/providers/local-platform-provider.ts:27`).
 * The memory router's initial entry is built from it, so it must not be empty. */
export const LOCAL_WORKSPACE_FALLBACK_SLUG = "local";

export function lodyWorkspaceSlug(snapshot: LodyPlatformSnapshot): string {
  return snapshot.workspace.slug ?? LOCAL_WORKSPACE_FALLBACK_SLUG;
}

export interface LodyPlatformFetchOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * A catalog the box served and this shell cannot read.
 *
 * NAMED SO THE POLLER CAN TELL IT FROM A TRANSPORT FAILURE. Both used to leave
 * this function as a bare throw, and `useLodyPlatformSnapshot` settled the
 * surface on either one — so "the tunnel is not up yet", which resolves by
 * itself in seconds, became "this workspace has no sessions", permanently, on
 * exactly the boxes that were still starting. A malformed catalog is a fact
 * about the BOX and stays terminal. A transport failure is a fact about the
 * MOMENT and has to be asked again.
 */
export class LodyPlatformCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LodyPlatformCatalogError";
  }
}

/** Reads the door once. `null` means "not ready yet" — the daemon writes the
 * catalog only after it provisions its workspace, and the bridge answers 503
 * until then. A malformed catalog throws {@link LodyPlatformCatalogError},
 * because that is a different fact; everything else this throws is transport. */
export async function fetchLodyPlatformSnapshot(
  platformUrl: string,
  options?: LodyPlatformFetchOptions,
): Promise<LodyPlatformSnapshot | null> {
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  // Deadline and reachability verdict both come from the helper (BUG-CV-01):
  // this is the 500 ms poller, and without a deadline a dead tunnel turned it
  // into an unbounded pile of sockets that never answer.
  const response = await boxGatewayFetch(platformUrl, fetchImpl, options?.signal);
  if (!response.ok) return null;
  // OUTSIDE the try: a body that stops arriving mid-read is the tunnel dying,
  // not a catalog this shell cannot parse, and must stay transport.
  const body = await response.text();
  try {
    return parseLodyPlatformSnapshot(parseJson(body));
  } catch (cause) {
    throw new LodyPlatformCatalogError(cause instanceof Error ? cause.message : String(cause));
  }
}
