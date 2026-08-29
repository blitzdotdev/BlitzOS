import { rows } from "../db.js";
import type { CoreRuntime } from "../runtime.js";
import type { FileSyncResult } from "./sync.js";

export interface AttachmentPass {
  result: FileSyncResult;
  /** Attachments that actually landed, per workspace. The files_ready flag is
   * derived from this, so a swallowed per-attachment failure must not count. */
  syncedByWorkspace: Map<string, number>;
}

/** Every folder the workspace expects on its guest, whether or not it is
 * syncable right now. This is the denominator for files_ready: a workspace
 * whose attacher lost their membership, or whose VM has no id yet, has rows
 * here that no pass can land, and it must not be called ready. */
async function attachedFolderCount(
  runtime: CoreRuntime,
  workspaceId: string,
): Promise<number> {
  const counted = await rows<{ total: number }>(runtime.db, {
    q: "SELECT COUNT(*) AS total FROM folder_attachments WHERE workspace_id = ?1",
    v: [workspaceId],
  });
  return counted[0]?.total ?? 0;
}

/** Flips files_ready once every attachment the workspace has actually landed,
 * and reports whether the guest is complete. The flag releases the box's
 * one-shot startup script against /workspace, so a partial or failed pass has
 * to leave it at 0 — the script never gets a second chance. It only ever
 * rises: a folder attached later must not claim the guest is unprepared again,
 * because the script has already run. */
export async function convergeFilesReady(
  runtime: CoreRuntime,
  workspaceId: string,
  syncedAttachments: number,
): Promise<boolean> {
  if (syncedAttachments < await attachedFolderCount(runtime, workspaceId)) return false;
  await rows(runtime.db, {
    q: `UPDATE workspaces SET files_ready = 1
        WHERE id = ?1 AND deleted_at IS NULL AND files_ready = 0`,
    v: [workspaceId],
  });
  return true;
}

/** Ready workspaces that expect no folders at all never appear in a sync pass:
 * boxes created without attachments, and rows that predate the column. The
 * sweep converges them so their startup script is not withheld forever. */
async function markUnattachedWorkspacesReady(runtime: CoreRuntime): Promise<void> {
  await rows(runtime.db, {
    q: `UPDATE workspaces SET files_ready = 1
        WHERE deleted_at IS NULL AND files_ready = 0
          AND NOT EXISTS (
            SELECT 1 FROM folder_attachments WHERE workspace_id = workspaces.id
          )`,
    v: [],
  });
}

/** Converges the flag for everything a whole-deployment sweep just touched,
 * plus the workspaces no pass can ever visit. */
export async function convergeSweepFilesReady(
  runtime: CoreRuntime,
  workspaceIds: Iterable<string>,
  syncedByWorkspace: ReadonlyMap<string, number>,
): Promise<void> {
  for (const workspaceId of new Set(workspaceIds)) {
    await convergeFilesReady(runtime, workspaceId, syncedByWorkspace.get(workspaceId) ?? 0);
  }
  await markUnattachedWorkspacesReady(runtime);
}
