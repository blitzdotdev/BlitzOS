import type {
  SessionFileOpenResult,
  SessionFileProviderEntry,
  SessionFileProviderState,
} from './session-file-provider';
import { getBasename } from './utils';

export type PinnedProviderFileContext = {
  readonly fileId?: string;
  readonly path: string;
  readonly providerState: SessionFileProviderState;
};

export function normalizePinnedProviderOpenResult(
  result: SessionFileOpenResult,
  context: PinnedProviderFileContext
): SessionFileOpenResult {
  if (
    result.status !== 'unavailable' ||
    result.entry !== undefined ||
    result.reason !== 'metadata-only' ||
    context.fileId === undefined ||
    context.providerState.kind !== 'code-collab' ||
    context.providerState.ready !== true
  ) {
    return result;
  }

  return {
    status: 'unavailable',
    entry: {
      fileId: context.fileId,
      path: context.path,
      kind: 'deleted',
      sourceState: 'degraded',
      readonly: true,
      unavailableReason: 'deleted',
    },
    reason: 'deleted',
    message: 'File was deleted from the collaborative workspace.',
  };
}

export type ProviderFileViewerTab = {
  readonly id: string;
  readonly type: 'file';
  readonly filePath: string;
  readonly fileId?: string;
  readonly label: string;
};

export function getProviderFileViewerTabId(filePath: string, fileId?: string): string {
  return `file:${fileId ?? filePath}`;
}

export function refreshPinnedProviderFileViewerTab<TTab extends ProviderFileViewerTab>(
  tab: TTab,
  entry: SessionFileProviderEntry | null
): TTab {
  if (tab.fileId === undefined || !entry || entry.path === tab.filePath) {
    return tab;
  }

  return {
    ...tab,
    id: getProviderFileViewerTabId(entry.path, entry.fileId ?? tab.fileId),
    filePath: entry.path,
    fileId: entry.fileId ?? tab.fileId,
    label: getBasename(entry.path),
  };
}
