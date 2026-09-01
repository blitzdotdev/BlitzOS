import type { SessionHistoryInput } from '@lody/shared';

/**
 * Pure helpers for the desktop local-transport backfill worker. The
 * orchestration (queue, upload, persistence) lives in `message-handler.ts`; this
 * module holds the deterministic, unit-testable pieces: backoff schedule and the
 * single-field history flip.
 */

export const SESSION_FILE_BACKFILL_BASE_DELAY_MS = 2_000;
export const SESSION_FILE_BACKFILL_MAX_DELAY_MS = 5 * 60_000;
export const SESSION_FILE_BACKFILL_MAX_ATTEMPTS = 8;

/**
 * Exponential backoff with a cap. `attempt` is 1-based (the delay to wait
 * *before* attempt N+1 after attempt N failed).
 */
export const sessionFileBackfillDelayMs = (attempt: number): number => {
  const exp = SESSION_FILE_BACKFILL_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(exp, SESSION_FILE_BACKFILL_MAX_DELAY_MS);
};

/** A `file` history item carrying transport/machine metadata. */
type FileHistoryItem = {
  type: 'file';
  fileId: string;
  transport: 'r2' | 'local';
  machineId?: string;
  [key: string]: unknown;
};

const isFileItem = (item: unknown): item is FileHistoryItem =>
  !!item &&
  typeof item === 'object' &&
  (item as { type?: unknown }).type === 'file' &&
  typeof (item as { fileId?: unknown }).fileId === 'string';

/**
 * Produce a new history array where the local-transport `file` item identified by
 * `localFileId` is flipped to `r2`: `transport: 'r2'`, `machineId` dropped, and
 * `fileId` rewritten to the relay-store key (`relayFileId`).
 *
 * Why `fileId` changes: the relay upload endpoint generates its own storage key
 * (the CLI cannot pin one). The download/preview URL is keyed by `fileId`, so the
 * persisted block MUST adopt the relay key once the bytes live in R2, or other
 * devices would request a non-existent object. All other fields (name, size,
 * sha256, textPreview, sibling items) are left untouched, so the rewrite is the
 * minimal change that keeps the block resolvable post-backfill.
 *
 * Returns `null` if no matching local-transport item was found (already flipped
 * or absent), so callers can skip the write.
 */
export const flipFileTransportToR2 = (
  history: readonly SessionHistoryInput[],
  localFileId: string,
  relayFileId: string
): SessionHistoryInput[] | null => {
  let changed = false;
  const next = history.map((entry) => {
    const items = Array.isArray(entry?.items) ? entry.items : null;
    if (!items) {
      return entry;
    }
    let entryChanged = false;
    const nextItems = items.map((item) => {
      if (isFileItem(item) && item.fileId === localFileId && item.transport === 'local') {
        entryChanged = true;
        changed = true;
        const { machineId: _machineId, ...rest } = item;
        return { ...rest, fileId: relayFileId, transport: 'r2' as const, machineId: undefined };
      }
      return item;
    });
    return entryChanged ? { ...entry, items: nextItems } : entry;
  });
  return changed ? (next as SessionHistoryInput[]) : null;
};
