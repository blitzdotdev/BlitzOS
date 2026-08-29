export type DirectoryHandle = {
  close(): Promise<void> | void;
};

export async function closeDirectoryQuietly(directory: DirectoryHandle): Promise<void> {
  try {
    await directory.close();
  } catch {
    // Directory iterators can already be closed by the runtime.
  }
}
