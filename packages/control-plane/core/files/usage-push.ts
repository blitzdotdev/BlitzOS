import { rows } from "../db.js";
import type { CoreRuntime } from "../runtime.js";
import {
  copyUp,
  EDITED_BY_METADATA,
  FILE_SYNC_MAX_FILES_PER_TICK,
  listGuestTree,
  listRemoteUnder,
  MTIME_METADATA,
  reserve,
  type GuestChannel,
  type SyncBudget,
} from "./dav.js";
import { folderObjectPrefix } from "./keys.js";

/**
 * The push-only leg of agent-usage capture (plans/RECIPES.md, decision 4).
 *
 * For every ready workspace of an org with usage_capture on, the bootstrap
 * bind-mounted the two native transcript HOME dirs read-only under this guest
 * root; this leg copies that subtree guest → R2 into the org usage folder
 * under `<workspaceId>/`, with a `meta.json` sidecar so the eval agent groups
 * runs by recipe without a D1 join.
 *
 * PUSH ONLY: nothing is ever materialized or written guest-ward for this
 * folder, and the folder is never auto-attached — a normal two-way
 * attachment would broadcast the whole org's transcripts into member boxes.
 */
const USAGE_GUEST_ROOT = "/workspace/shared/agent-usage/";

/** The sidecar layout is AI-read, pinned here with the directory layout:
 * `<folder>/<workspaceId>/meta.json` beside `<workspaceId>/claude/**` and
 * `<workspaceId>/codex/**` vendor blobs (deliberately unparsed). */
interface UsageMeta {
  workspaceId: string;
  recipeId: string | null;
  ownerMembershipId: string;
  workspaceName: string;
}

interface UsageWorkspaceRow extends GuestChannel {
  org_id: string;
  usage_folder_id: string;
  recipe_id: string | null;
  owner_membership_id: string;
  workspace_name: string;
  owner_name: string;
}

async function usageWorkspaceRows(runtime: CoreRuntime): Promise<UsageWorkspaceRow[]> {
  // The folders join drops orgs whose usage folder disappeared out-of-band;
  // folder deletion also clears the org columns, so this is belt and braces.
  return rows<UsageWorkspaceRow>(runtime.db, {
    q: `SELECT workspace.id AS workspace_id, workspace.vm_id,
               workspace.tunnel_hostname, workspace.org_id,
               workspace.recipe_id, workspace.owner_membership_id,
               workspace.name AS workspace_name,
               org.usage_folder_id, owner_user.name AS owner_name
        FROM workspaces workspace
        JOIN orgs org
          ON org.id = workspace.org_id
         AND org.usage_capture = 1
         AND org.usage_folder_id IS NOT NULL
        JOIN folders folder ON folder.id = org.usage_folder_id
        JOIN memberships owner ON owner.id = workspace.owner_membership_id
        JOIN users owner_user ON owner_user.id = owner.user_id
        WHERE workspace.phase = 'ready' AND workspace.vm_id IS NOT NULL
        ORDER BY workspace.created_at, workspace.id`,
    v: [],
  });
}

/** Written once per workspace; the HEAD probe keeps the refresh at one cheap
 * subrequest per tick. */
async function ensureMeta(
  runtime: CoreRuntime,
  target: UsageWorkspaceRow,
  prefix: string,
): Promise<void> {
  const key = `${prefix}meta.json`;
  if (await runtime.fileObjects.head(key) !== null) return;
  const meta: UsageMeta = {
    workspaceId: target.workspace_id,
    recipeId: target.recipe_id,
    ownerMembershipId: target.owner_membership_id,
    workspaceName: target.workspace_name,
  };
  await runtime.fileObjects.put(key, JSON.stringify(meta), {
    httpMetadata: { contentType: "application/json" },
    // The usage folder is a normal Drive folder for its grant holders, so the
    // sidecar carries the same metadata every synced object does.
    customMetadata: {
      [MTIME_METADATA]: String(Date.now()),
      [EDITED_BY_METADATA]: target.owner_name,
    },
  });
}

async function pushWorkspaceUsage(
  runtime: CoreRuntime,
  target: UsageWorkspaceRow,
  budget: SyncBudget,
): Promise<number> {
  const guestFiles = await listGuestTree(runtime, target, USAGE_GUEST_ROOT);
  // Push only: a guest without the capture mounts (pre-capture boot) gets
  // nothing created, not even the root collection.
  if (guestFiles === null || guestFiles.size === 0) return 0;
  const prefix = `${folderObjectPrefix(target.org_id, target.usage_folder_id)}${target.workspace_id}/`;
  await ensureMeta(runtime, target, prefix);
  const remote = await listRemoteUnder(runtime, prefix);
  let pushed = 0;
  let failedFiles = 0;
  let firstFileError = "";
  for (const [key, guest] of [...guestFiles.entries()].sort(([a], [b]) => a < b ? -1 : 1)) {
    // The sidecar name is reserved; the guest cannot produce it at the root
    // (only the two mount dirs live there), but hold the line anyway.
    if (key === "meta.json") continue;
    const existing = remote.get(key);
    if (existing !== undefined && existing.size === guest.size && existing.mtime === guest.mtime) {
      continue;
    }
    if (!reserve(budget, guest.size)) continue;
    try {
      await copyUp(runtime, target, USAGE_GUEST_ROOT, guest, `${prefix}${key}`, target.owner_name);
      pushed += 1;
    } catch (caught) {
      failedFiles += 1;
      if (firstFileError === "") {
        firstFileError = `${key}: ${caught instanceof Error ? caught.message : String(caught)}`;
      }
    }
  }
  if (failedFiles > 0) {
    runtime.reportError(
      "usage_capture_file_failed",
      new Error(
        `${String(failedFiles)} usage files failed for ${target.workspace_id} — first: ${firstFileError}`,
      ),
    );
  }
  return pushed;
}

export interface UsagePushResult {
  workspaces: number;
  files: number;
}

/** Runs inside the file-sync tick, after the attachment pass, sharing its
 * budget. One failing workspace must not starve the rest. */
export async function runUsageCapturePush(
  runtime: CoreRuntime,
  budget: SyncBudget,
): Promise<UsagePushResult> {
  const targets = await usageWorkspaceRows(runtime);
  let workspaces = 0;
  let files = 0;
  for (const target of targets) {
    if (budget.files >= FILE_SYNC_MAX_FILES_PER_TICK) break;
    try {
      const pushed = await pushWorkspaceUsage(runtime, target, budget);
      if (pushed > 0) {
        workspaces += 1;
        files += pushed;
      }
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : String(caught);
      runtime.reportError(
        "usage_capture_push_failed",
        new Error(`${target.workspace_id}: ${detail}`),
      );
    }
  }
  return { workspaces, files };
}
