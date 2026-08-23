import { rows } from "../db.js";
import { HttpError } from "../http.js";
import type { Principal } from "../principals.js";
import type { CoreRuntime } from "../runtime.js";
import {
  copyUp,
  FILE_SYNC_MAX_FILES_PER_TICK,
  guestObjectPath,
  guestRequest,
  listGuestTree,
  listRemoteUnder,
  reserve,
  type DavEntry,
  type GuestChannel,
  type RemoteEntry,
  type SyncBudget,
} from "./dav.js";
import { folderObjectPrefix } from "./keys.js";
import { requireFolderAccess, type FilesActor, type FolderRole } from "./access.js";
import {
  convergeFilesReady,
  convergeSweepFilesReady,
  type AttachmentPass,
} from "./readiness.js";
import { scheduleSync } from "./schedule.js";
import { runUsageCapturePush } from "./usage-push.js";

interface SyncAttachmentRow extends GuestChannel {
  folder_id: string;
  folder_name: string;
  attached_by_membership_id: string;
  attacher_user_id: string;
  attacher_org_id: string;
  attacher_role: "admin" | "member";
  owner_name: string;
  guest_path: string | null;
}

export interface FileSyncResult {
  attachments: number;
  files: number;
  bytes: number;
}

function syncPrincipal(row: SyncAttachmentRow): Principal {
  return {
    id: row.attacher_user_id,
    unixName: "blitz",
    harnesses: [],
    membershipId: row.attached_by_membership_id,
    orgId: row.attacher_org_id,
    role: row.attacher_role,
    platformOperator: false,
  };
}

/** Published workspace directories keep their original guest path; plain
 * attachments materialize under /workspace/shared/<name>. */
function guestRoot(attachment: SyncAttachmentRow): string {
  const relative = attachment.guest_path ?? `shared/${attachment.folder_name}`;
  return `/workspace/${relative.split("/").map(encodeURIComponent).join("/")}/`;
}

/** Lists the attachment's guest tree, materializing the folder root when the
 * guest does not have it yet. MKCOL rejects missing intermediates
 * (RFC 4918: 409), and a fresh guest has no /workspace/shared — build the
 * chain segment by segment. */
async function listGuest(
  runtime: CoreRuntime,
  attachment: SyncAttachmentRow,
  root: string,
): Promise<Map<string, DavEntry>> {
  const files = await listGuestTree(runtime, attachment, root);
  if (files !== null) return files;
  const segments = root.replace(/^\/workspace\//u, "").split("/").filter(Boolean);
  let prefix = "/workspace/";
  for (const segment of segments) {
    prefix = `${prefix}${segment}/`;
    const mkcol = await guestRequest(
      runtime,
      attachment,
      prefix,
      new Request("https://control-plane.invalid", { method: "MKCOL" }),
    );
    if (mkcol.status !== 201 && mkcol.status !== 405) {
      throw new Error(`WebDAV MKCOL failed with status ${mkcol.status}`);
    }
    await mkcol.body?.cancel();
  }
  return new Map();
}

async function copyDown(
  runtime: CoreRuntime,
  attachment: SyncAttachmentRow,
  root: string,
  remote: RemoteEntry,
): Promise<void> {
  const object = await runtime.fileObjects.get(remote.object.key);
  if (object === null) return;
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-length", String(object.size));
  const response = await guestRequest(
    runtime,
    attachment,
    guestObjectPath(root, remote.key),
    new Request("https://control-plane.invalid", {
      method: "PUT",
      headers,
      body: object.body.pipeThrough(new FixedLengthStream(object.size)),
    }),
  );
  if (response.status !== 200 && response.status !== 201 && response.status !== 204) {
    throw new Error(`WebDAV PUT failed with status ${response.status}`);
  }
  await response.body?.cancel();
}

function canUpload(role: FolderRole): boolean {
  return role !== "viewer";
}

async function syncAttachment(
  runtime: CoreRuntime,
  attachment: SyncAttachmentRow,
  budget: SyncBudget,
): Promise<boolean> {
  const actor: FilesActor = {
    principal: syncPrincipal(attachment),
    editedBy: attachment.owner_name,
  };
  let folder: Awaited<ReturnType<typeof requireFolderAccess>>;
  try {
    // Revocation is enforced here before the tick touches R2 or the guest.
    folder = await requireFolderAccess(runtime.db, attachment.folder_id, actor, "read");
  } catch (caught) {
    if (caught instanceof HttpError && (caught.status === 403 || caught.status === 404)) {
      return false;
    }
    throw caught;
  }
  const root = guestRoot(attachment);
  const [remoteFiles, guestFiles] = await Promise.all([
    listRemoteUnder(runtime, folderObjectPrefix(folder.org_id, folder.id)),
    listGuest(runtime, attachment, root),
  ]);
  let uploaded = false;
  let failedFiles = 0;
  let firstFileError = "";
  // One failing transfer must not starve every file sorted after it — the
  // pass continues and the next tick retries the failures with fresh
  // listings.
  const transfer = async (key: string, run: () => Promise<void>) => {
    try {
      await run();
      return true;
    } catch (caught) {
      failedFiles += 1;
      if (firstFileError === "") {
        firstFileError = `${key}: ${caught instanceof Error ? caught.message : String(caught)}`;
      }
      return false;
    }
  };
  const keys = new Set([...remoteFiles.keys(), ...guestFiles.keys()]);
  for (const key of [...keys].sort()) {
    const remote = remoteFiles.get(key);
    const guest = guestFiles.get(key);
    if (remote === undefined && guest !== undefined) {
      if (!canUpload(folder.role) || !reserve(budget, guest.size)) continue;
      if (await transfer(key, () => copyUp(
        runtime,
        attachment,
        root,
        guest,
        `${folderObjectPrefix(folder.org_id, folder.id)}${guest.key}`,
        attachment.owner_name,
      ))) uploaded = true;
      continue;
    }
    if (remote !== undefined && guest === undefined) {
      if (!reserve(budget, remote.size)) continue;
      await transfer(key, () => copyDown(runtime, attachment, root, remote));
      continue;
    }
    if (remote === undefined || guest === undefined) continue;
    if (remote.size === guest.size && remote.mtime === guest.mtime) continue;
    if (remote.mtime >= guest.mtime) {
      if (!reserve(budget, remote.size)) continue;
      await transfer(key, () => copyDown(runtime, attachment, root, remote));
    } else if (canUpload(folder.role) && reserve(budget, guest.size)) {
      if (await transfer(key, () => copyUp(
        runtime,
        attachment,
        root,
        guest,
        `${folderObjectPrefix(folder.org_id, folder.id)}${guest.key}`,
        attachment.owner_name,
      ))) uploaded = true;
    }
  }
  if (failedFiles > 0) {
    runtime.reportError(
      "folder_sync_file_failed",
      new Error(
        `${String(failedFiles)} files failed for ${attachment.workspace_id}/${attachment.folder_id} — first: ${firstFileError}`,
      ),
    );
  }
  if (uploaded) {
    await rows(runtime.db, {
      q: "UPDATE folders SET updated_at = ?1 WHERE id = ?2",
      v: [Date.now(), folder.id],
    });
  }
  // There is deliberately no delete state. R2 restores guest-side deletions;
  // for editor+ attachments, guest files restore R2-side deletions. Viewer-only
  // guest files are ignored because that role is strictly down-sync.
  return true;
}

interface AttachmentFilter {
  folderId?: string;
  workspaceId?: string;
}

async function attachmentRows(
  runtime: CoreRuntime,
  filter: AttachmentFilter = {},
): Promise<SyncAttachmentRow[]> {
  const scope = filter.folderId !== undefined
    ? "WHERE attachment.folder_id = ?1"
    : filter.workspaceId !== undefined
      ? "WHERE attachment.workspace_id = ?1"
      : "";
  const value = filter.folderId ?? filter.workspaceId;
  return rows<SyncAttachmentRow>(runtime.db, {
    q: `SELECT attachment.workspace_id, workspace.vm_id,
               workspace.tunnel_hostname, attachment.folder_id,
               folder.name AS folder_name,
               attachment.attached_by_membership_id,
               attacher.user_id AS attacher_user_id,
               attacher.org_id AS attacher_org_id,
               attacher.role AS attacher_role,
               owner_user.name AS owner_name, attachment.guest_path
        FROM folder_attachments attachment
        JOIN folders folder ON folder.id = attachment.folder_id
        JOIN workspaces workspace
          ON workspace.id = attachment.workspace_id
         AND workspace.phase = 'ready'
         AND workspace.vm_id IS NOT NULL
        JOIN memberships attacher
          ON attacher.id = attachment.attached_by_membership_id
         AND attacher.status = 'active'
        JOIN memberships owner ON owner.id = workspace.owner_membership_id
        JOIN users owner_user ON owner_user.id = owner.user_id
        ${scope}
        ORDER BY attachment.created_at, attachment.workspace_id, attachment.folder_id`,
    v: value === undefined ? [] : [value],
  });
}

async function runAttachmentPass(
  runtime: CoreRuntime,
  attachments: SyncAttachmentRow[],
  budget: SyncBudget = { files: 0, bytes: 0 },
): Promise<AttachmentPass> {
  const syncedByWorkspace = new Map<string, number>();
  let synced = 0;
  for (const attachment of attachments) {
    if (budget.files >= FILE_SYNC_MAX_FILES_PER_TICK) break;
    try {
      if (await syncAttachment(runtime, attachment, budget)) {
        synced += 1;
        syncedByWorkspace.set(
          attachment.workspace_id,
          (syncedByWorkspace.get(attachment.workspace_id) ?? 0) + 1,
        );
      }
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : String(caught);
      runtime.reportError(
        "folder_sync_failed",
        new Error(`${attachment.workspace_id}/${attachment.folder_id}: ${detail}`),
      );
    }
  }
  return {
    result: { attachments: synced, files: budget.files, bytes: budget.bytes },
    syncedByWorkspace,
  };
}

/** The five-minute backstop. It converges files_ready as well as file content,
 * so a workspace whose fire-and-forget pass at phone-home was lost still
 * releases its startup script. The push-only usage-capture leg rides the same
 * tick and the same budget so a capturing org can never double the caps. */
export async function runFileSyncSweep(runtime: CoreRuntime): Promise<FileSyncResult> {
  const attachments = await attachmentRows(runtime);
  const budget: SyncBudget = { files: 0, bytes: 0 };
  const pass = await runAttachmentPass(runtime, attachments, budget);
  await convergeSweepFilesReady(
    runtime,
    attachments.map(({ workspace_id }) => workspace_id),
    pass.syncedByWorkspace,
  );
  await runUsageCapturePush(runtime, budget);
  return { attachments: pass.result.attachments, files: budget.files, bytes: budget.bytes };
}

export async function runFolderSync(
  runtime: CoreRuntime,
  folderId: string,
): Promise<FileSyncResult> {
  return (await runAttachmentPass(runtime, await attachmentRows(runtime, { folderId }))).result;
}

export async function runWorkspaceFileSync(
  runtime: CoreRuntime,
  workspaceId: string,
): Promise<FileSyncResult> {
  return (await runAttachmentPass(runtime, await attachmentRows(runtime, { workspaceId }))).result;
}

/** How long an incomplete ready-time pass waits before retrying, sized for a
 * tunnel that is seconds from connecting; anything slower is the sweep's job. */
const READY_RETRY_DELAYS_MS = [8_000, 15_000] as const;

/** Materializes a just-booted workspace's attachments. The guest phones home
 * while its tunnel may still be connecting, so an incomplete first pass retries
 * briefly before the five-minute sweep takes over as the backstop. */
export async function runReadyWorkspaceFileSync(
  runtime: CoreRuntime,
  workspaceId: string,
): Promise<FileSyncResult> {
  let pass = await runAttachmentPass(runtime, await attachmentRows(runtime, { workspaceId }));
  const settled = async (): Promise<boolean> => convergeFilesReady(
    runtime,
    workspaceId,
    pass.syncedByWorkspace.get(workspaceId) ?? 0,
  );
  let complete = await settled();
  for (const delayMs of READY_RETRY_DELAYS_MS) {
    if (complete) break;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    pass = await runAttachmentPass(runtime, await attachmentRows(runtime, { workspaceId }));
    complete = await settled();
  }
  return pass.result;
}

export function scheduleFolderSync(runtime: CoreRuntime, folderId: string): void {
  scheduleSync(runtime, (syncRuntime) => runFolderSync(syncRuntime, folderId));
}
