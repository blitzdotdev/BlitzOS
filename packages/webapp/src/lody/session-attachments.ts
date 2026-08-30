/**
 * The far end of the `+` attachment button (plans/LODY-SESSIONS.md §0.7,
 * plans/LODY-RUNTIME-DESIGN.md §10.4).
 *
 * Lody's desktop fast path hands attachment bytes to the local CLI: the Electron
 * MAIN process writes each file to a temp path and then posts
 * `session/file-send-local` with those paths, and the daemon copies each one into
 * its own blob store and answers with `transport: 'local'` blocks the composer
 * attaches to the outgoing message
 * (`apps/electron/src/main/ipc/services/local-projects-ipc.ts:79`). The cloud
 * fallback beside it uploads to Lody cloud, which this composition has no account
 * for.
 *
 * On a box the "main process" is the box and the browser is not, so the temp file
 * has to be written ACROSS the gateway. The bytes go over the dufs WebDAV surface
 * the workspace already serves — the same route `file-drop.ts` uses for a
 * screenshot dropped on a terminal — and land under
 * `/workspace/.blitz-attachments/<sessionId>/`. Nothing new is opened: §10.4
 * weighed a second gateway prefix rooted at the daemon's data dir against reusing
 * `/workspace`, and reusing it costs no `webapp-surface.ts` entry and no Go
 * change.
 *
 * The directory is a STAGING area, not storage. The daemon copies the bytes out
 * during the handoff, so each file is deleted again as soon as the control call
 * returns — the same lifecycle Electron gives its temp directory.
 *
 * MKCOL, then PUT. dufs does not create missing intermediates, which
 * `core/files/sync.ts:75` already records for the control plane's own uploads, so
 * the two collection segments are created segment by segment and a 405 ("already
 * there") is success.
 */
import type { JsonValue } from "@blitzos/schema";
import { FILES_DAV_ROOT } from "../resolver.js";
import type { LodyIpcArgument, LodySendSessionFileLocalInput } from "./wire-types.js";

/** Where a session's staged attachments live under the workspace tree. A dot
 * name so the Finder's own listing and a repo scan both skip it. */
export const SESSION_ATTACHMENTS_DIR = ".blitz-attachments";

export interface LodyAttachmentEndpoints {
  /** `BoxEndpoints.filesBase` — the dufs WebDAV base, ending in a slash. */
  filesBase: string;
  /**
   * The box path that base serves. dufs's document root is the box's
   * `/workspace`, and the path handed to the daemon is a path in the BOX's
   * filesystem, so the URL and the path have to name the same directory. The
   * default is the one the resolver builds; a test that stands dufs up
   * elsewhere moves both together.
   */
  filesRoot?: string;
  fetchImpl?: typeof fetch;
}

/** One file, as `sendSessionFileLocal` receives it from the composer. */
export interface LodyAttachmentFile {
  fileName: string;
  bytes: ArrayBuffer;
}

/**
 * Recognizes the channel argument, mirroring the vendored
 * `parseSendSessionFileLocalInput` (`local-projects-ipc.ts:24`).
 *
 * It arrives from the vendored renderer rather than from the network, but it is
 * still the boundary of this package and it carries an `ArrayBuffer` no zod
 * schema on either side covers — Lody validates it by hand for the same reason.
 *
 * A TYPE GUARD rather than a parser, and that is what makes the widening of
 * `LodyIpcArgument` free everywhere else: its false branch narrows the union
 * back to `JsonValue | undefined`, which is what every other channel takes.
 */
export function isSendSessionFileLocalInput(
  value: LodyIpcArgument,
): value is LodySendSessionFileLocalInput {
  return (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && "workspaceId" in value && typeof value.workspaceId === "string"
    && "sessionId" in value && typeof value.sessionId === "string"
    && "machineId" in value && typeof value.machineId === "string"
    && "files" in value
    && Array.isArray(value.files)
    && value.files.length > 0
    && value.files.every(isAttachmentFile)
  );
}

function isAttachmentFile(value: JsonValue | LodyAttachmentFile): value is LodyAttachmentFile {
  return (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && "fileName" in value && typeof value.fileName === "string"
    && "bytes" in value && value.bytes instanceof ArrayBuffer
  );
}

export type LodyAttachmentUpload =
  /** `paths` is what the daemon reads; `staged` is what the cleanup pass
   * deletes. Both are produced by the one loop that wrote the files, so the
   * cleanup cannot drift from the upload. */
  | { ok: true; paths: string[]; staged: string[][] }
  | { ok: false; error: string };

/**
 * The name a file takes on disk, byte-for-byte what Electron's own handoff
 * computes (`local-projects-ipc.ts:86`). Kept identical rather than improved:
 * the daemon reports the basename back as the block's file name, so a different
 * rule here would show a different name in the transcript on a box than on the
 * desktop.
 */
export function safeAttachmentName(fileName: string, index: number): string {
  const base = [...fileName.split(/[\\/]/u).pop() ?? ""]
    .map((character) => (character.charCodeAt(0) < 32 ? "_" : character))
    .join("")
    .trim();
  const safe = base === "" || base === "." || base === ".." ? "file" : base.slice(0, 255);
  return `${index}-${safe}`;
}

function davUrl(endpoints: LodyAttachmentEndpoints, segments: readonly string[]): string {
  const base = endpoints.filesBase.endsWith("/") ? endpoints.filesBase : `${endpoints.filesBase}/`;
  return `${base}${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

function boxPath(endpoints: LodyAttachmentEndpoints, segments: readonly string[]): string {
  const root = (endpoints.filesRoot ?? FILES_DAV_ROOT).replace(/\/+$/u, "");
  return `${root}/${segments.join("/")}`;
}

async function makeCollection(
  endpoints: LodyAttachmentEndpoints,
  segments: readonly string[],
): Promise<string | null> {
  const fetchImpl = endpoints.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(`${davUrl(endpoints, segments)}/`, {
    method: "MKCOL",
    credentials: "include",
  });
  await response.body?.cancel();
  // 405 is "the collection is already there", which is the ordinary case after
  // the first attachment of a session.
  if (response.status === 201 || response.status === 405) return null;
  return `attachment_mkcol_${response.status}`;
}

/**
 * Stages every file on the box and returns the paths the daemon will read.
 *
 * All-or-nothing: a partial upload would hand the daemon a shorter `paths` array
 * than the composer has pending files, and it answers per-batch, so the composer
 * could not tell which file failed. On any failure the files already written are
 * removed and the caller falls back the way it does with no bridge at all.
 */
export async function uploadSessionAttachments(
  endpoints: LodyAttachmentEndpoints,
  sessionId: string,
  files: readonly LodyAttachmentFile[],
): Promise<LodyAttachmentUpload> {
  if (files.length === 0) return { ok: false, error: "attachment_empty" };
  const fetchImpl = endpoints.fetchImpl ?? globalThis.fetch;
  const directory = [SESSION_ATTACHMENTS_DIR, sessionId];
  for (const depth of [1, 2]) {
    const failure = await makeCollection(endpoints, directory.slice(0, depth));
    if (failure !== null) return { ok: false, error: failure };
  }
  const written: string[][] = [];
  const paths: string[] = [];
  for (const [index, file] of files.entries()) {
    const segments = [...directory, safeAttachmentName(file.fileName, index)];
    const response = await fetchImpl(davUrl(endpoints, segments), {
      method: "PUT",
      body: file.bytes,
      credentials: "include",
    });
    await response.body?.cancel();
    if (response.status < 200 || response.status >= 300) {
      await removeSessionAttachments(endpoints, written);
      return { ok: false, error: `attachment_put_${response.status}` };
    }
    written.push(segments);
    paths.push(boxPath(endpoints, segments));
  }
  return { ok: true, paths, staged: written };
}

/** Deletes staged files. Best effort: the bytes are already in the daemon's blob
 * store by the time this runs, so a failure costs a stale file and nothing else,
 * and reporting it would turn a successful attachment into a failed one. */
export async function removeSessionAttachments(
  endpoints: LodyAttachmentEndpoints,
  written: readonly (readonly string[])[],
): Promise<void> {
  const fetchImpl = endpoints.fetchImpl ?? globalThis.fetch;
  for (const segments of written) {
    try {
      const response = await fetchImpl(davUrl(endpoints, segments), {
        method: "DELETE",
        credentials: "include",
      });
      await response.body?.cancel();
    } catch {
      // See the doc comment.
    }
  }
}
