/** Drag-and-drop payload traversal. `webkitGetAsEntry` is the only widely
 * shipped way to walk dropped directories; when entries are unavailable the
 * plain file list is the fallback and directories are invisible. */

export interface DroppedFile {
  file: File;
  relativePath: string;
}

export interface DroppedFolder {
  name: string;
  files: DroppedFile[];
}

export interface DroppedPayload {
  files: DroppedFile[];
  folders: DroppedFolder[];
}

export const MAX_DROP_FILES = 500;
export const MAX_DROP_BYTES = 1024 * 1024 * 1024;

/** A drop past the caps is refused whole rather than partially uploaded. */
export class DropLimitError extends Error {
  public constructor(public readonly fileCount: number, public readonly totalBytes: number) {
    super(fileCount > MAX_DROP_FILES
      ? `That drop has over ${String(MAX_DROP_FILES)} files — zip it or sync it through a workspace instead`
      : 'That drop is over 1 GB — zip it or sync it through a workspace instead');
    this.name = 'DropLimitError';
  }
}

interface DropBudget {
  files: number;
  bytes: number;
}

function reserveDropBudget(budget: DropBudget, file: File): void {
  budget.files += 1;
  budget.bytes += file.size;
  if (budget.files > MAX_DROP_FILES || budget.bytes > MAX_DROP_BYTES) {
    throw new DropLimitError(budget.files, budget.bytes);
  }
}

interface EntryFileSource {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (resolve: (file: File) => void, reject: (error: Error) => void) => void;
  createReader?: () => {
    readEntries: (
      resolve: (entries: EntryFileSource[]) => void,
      reject: (error: Error) => void,
    ) => void;
  };
}

function entryFile(entry: EntryFileSource): Promise<File> {
  return new Promise((resolve, reject) => {
    if (entry.file === undefined) {
      reject(new Error(`dropped entry ${entry.name} has no file reader`));
      return;
    }
    entry.file(resolve, reject);
  });
}

async function readAllEntries(entry: EntryFileSource): Promise<EntryFileSource[]> {
  const reader = entry.createReader?.();
  if (reader === undefined) return [];
  const collected: EntryFileSource[] = [];
  // readEntries returns results in batches and signals the end with an
  // empty batch; a single call silently truncates at ~100 entries.
  for (;;) {
    const batch = await new Promise<EntryFileSource[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (batch.length === 0) return collected;
    collected.push(...batch);
  }
}

async function collectInto(
  entry: EntryFileSource,
  prefix: string,
  sink: DroppedFile[],
  budget: DropBudget,
): Promise<void> {
  if (entry.isFile) {
    const file = await entryFile(entry);
    reserveDropBudget(budget, file);
    sink.push({
      file,
      relativePath: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
    });
    return;
  }
  if (!entry.isDirectory) return;
  const children = await readAllEntries(entry);
  const next = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
  for (const child of children) {
    await collectInto(child, next, sink, budget);
  }
}

/** Entry accessor shape of DataTransferItem, injectable for tests. */
export interface DropItemSource {
  webkitGetAsEntry?: () => EntryFileSource | null;
  getAsFile?: () => File | null;
}

export async function collectDropped(
  items: readonly DropItemSource[],
  fallbackFiles: readonly File[],
): Promise<DroppedPayload> {
  // Browsers invalidate DataTransferItems once the drop handler yields, so
  // every webkitGetAsEntry call must happen before the first await. The
  // FileSystemEntry objects themselves survive past the event.
  const entries = items
    .map((item) => item.webkitGetAsEntry?.() ?? null)
    .filter((entry): entry is EntryFileSource => entry !== null);
  const payload: DroppedPayload = { files: [], folders: [] };
  const budget: DropBudget = { files: 0, bytes: 0 };
  for (const entry of entries) {
    if (entry.isDirectory) {
      const folder: DroppedFolder = { name: entry.name, files: [] };
      const children = await readAllEntries(entry);
      for (const child of children) {
        await collectInto(child, '', folder.files, budget);
      }
      payload.folders.push(folder);
      continue;
    }
    if (entry.isFile) {
      const file = await entryFile(entry);
      reserveDropBudget(budget, file);
      payload.files.push({ file, relativePath: entry.name });
    }
  }
  if (entries.length === 0) {
    for (const file of fallbackFiles) {
      reserveDropBudget(budget, file);
      payload.files.push({ file, relativePath: file.name });
    }
  }
  return payload;
}
