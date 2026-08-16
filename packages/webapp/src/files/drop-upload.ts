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
): Promise<void> {
  if (entry.isFile) {
    sink.push({
      file: await entryFile(entry),
      relativePath: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
    });
    return;
  }
  if (!entry.isDirectory) return;
  const children = await readAllEntries(entry);
  const next = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
  for (const child of children) {
    await collectInto(child, next, sink);
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
  for (const entry of entries) {
    if (entry.isDirectory) {
      const folder: DroppedFolder = { name: entry.name, files: [] };
      const children = await readAllEntries(entry);
      for (const child of children) {
        await collectInto(child, '', folder.files);
      }
      payload.folders.push(folder);
      continue;
    }
    if (entry.isFile) {
      payload.files.push({ file: await entryFile(entry), relativePath: entry.name });
    }
  }
  if (entries.length === 0) {
    for (const file of fallbackFiles) {
      payload.files.push({ file, relativePath: file.name });
    }
  }
  return payload;
}
