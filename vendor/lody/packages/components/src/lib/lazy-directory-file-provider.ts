import type {
  FileWorkspaceOpenResult,
  FileWorkspaceProvider,
  FileWorkspaceProviderEntry,
  FileWorkspaceProviderState,
} from './file-workspace-provider';

export function joinProjectPath(parentPath: string, name: string): string {
  return parentPath ? `${parentPath}/${name}` : name;
}

export function toFileEntry(path: string, sizeBytes?: number): FileWorkspaceProviderEntry {
  return {
    entryType: 'file',
    path,
    kind: 'text',
    sourceState: 'live-readonly',
    readonly: true,
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
  };
}

export function toDirectoryEntry(path: string): FileWorkspaceProviderEntry {
  return {
    entryType: 'lazy-directory',
    directoryId: path,
    path,
    kind: 'special',
    sourceState: 'live-readonly',
    readonly: true,
    unavailableReason: 'metadata-only',
  };
}

/**
 * Shared scaffolding for read-only providers that load one directory level at a
 * time and accumulate entries as the user drills in (GitHub repo browsing and
 * local-project machine RPC). Subclasses supply only the per-source directory
 * fetch (`loadDirectoryEntries`) plus `searchFiles`/`openFile`; the lazy-load
 * dedup, subscriber fan-out, root-error tracking, and snapshot sorting live here
 * so the variants stay in lockstep.
 */
export abstract class LazyDirectoryFileProvider implements FileWorkspaceProvider {
  readonly kind = 'code-collab' as const;

  protected readonly entries = new Map<string, FileWorkspaceProviderEntry>();
  private readonly loadedDirectories = new Set<string>();
  private readonly directoryLoadPromises = new Map<string, Promise<void>>();
  private readonly subscribers = new Set<(files: readonly FileWorkspaceProviderEntry[]) => void>();
  protected rootError: string | undefined;

  getState(): FileWorkspaceProviderState {
    return {
      kind: this.kind,
      ready: this.rootError === undefined,
      sourceState: this.rootError === undefined ? 'live-readonly' : 'degraded',
      ...(this.rootError === undefined ? {} : { message: this.rootError }),
    };
  }

  async listFiles(): Promise<readonly FileWorkspaceProviderEntry[]> {
    await this.loadDirectory('');
    return this.snapshotEntries();
  }

  subscribeFiles(callback: (files: readonly FileWorkspaceProviderEntry[]) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async initializeDirectory(directoryId: string): Promise<void> {
    try {
      await this.loadDirectory(directoryId);
    } finally {
      this.emit();
    }
  }

  async getFile(pathOrFileId: string): Promise<FileWorkspaceProviderEntry | null> {
    return this.entries.get(pathOrFileId) ?? toFileEntry(pathOrFileId);
  }

  async saveText(pathOrFileId: string): Promise<FileWorkspaceOpenResult> {
    return {
      status: 'unavailable',
      entry: this.entries.get(pathOrFileId) ?? toFileEntry(pathOrFileId),
      reason: 'permission-denied',
      message: 'Project files are read-only here.',
    };
  }

  abstract searchFiles(query: string): Promise<readonly FileWorkspaceProviderEntry[]>;
  abstract openFile(pathOrFileId: string): Promise<FileWorkspaceOpenResult>;

  /**
   * Fetch a single directory level and return its entries. Implementations may
   * record source-specific bookkeeping (e.g. GitHub tree SHAs) as a side effect.
   */
  protected abstract loadDirectoryEntries(
    relativePath: string
  ): Promise<readonly FileWorkspaceProviderEntry[]>;

  private async loadDirectory(relativePath: string): Promise<void> {
    if (this.loadedDirectories.has(relativePath)) {
      return;
    }
    const existing = this.directoryLoadPromises.get(relativePath);
    if (existing) {
      return await existing;
    }

    const promise = this.loadDirectoryOnce(relativePath).finally(() => {
      this.directoryLoadPromises.delete(relativePath);
    });
    this.directoryLoadPromises.set(relativePath, promise);
    return await promise;
  }

  private async loadDirectoryOnce(relativePath: string): Promise<void> {
    try {
      const entries = await this.loadDirectoryEntries(relativePath);
      for (const entry of entries) {
        this.entries.set(entry.path, entry);
      }
      this.loadedDirectories.add(relativePath);
      if (!relativePath) {
        this.rootError = undefined;
      }
    } catch (error) {
      if (!relativePath) {
        this.rootError = error instanceof Error ? error.message : String(error);
      }
      throw error;
    }
  }

  private snapshotEntries(): readonly FileWorkspaceProviderEntry[] {
    return Array.from(this.entries.values()).sort((left, right) =>
      left.path.localeCompare(right.path)
    );
  }

  private emit(): void {
    const snapshot = this.snapshotEntries();
    for (const subscriber of this.subscribers) {
      subscriber(snapshot);
    }
  }
}
