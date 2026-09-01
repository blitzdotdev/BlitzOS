import type { CodeCollabFileSourceState, CodeCollabRole } from '@lody/shared';
import {
  CodeCollabSessionFileProvider,
  type CodeCollabSessionFileProviderCache,
  type CodeCollabSessionFileProviderRuntime,
} from './code-collab-session-file-provider';
import type {
  SessionFileChangedFilesResult,
  SessionFileDiffResult,
  SessionFileOpenResult,
  SessionFileProvider,
  SessionFileProviderEntry,
  SessionFileProviderMode,
  SessionFileProviderState,
} from './session-file-provider';

export type SessionFileProviderSource =
  | {
      readonly kind: 'code-collab';
      readonly runtime: CodeCollabSessionFileProviderRuntime;
      readonly role: CodeCollabRole;
      readonly sourceState?: CodeCollabFileSourceState;
      readonly historicalTurnId?: string;
      readonly cache?: CodeCollabSessionFileProviderCache;
    }
  | {
      readonly kind: 'none';
      readonly message?: string;
    };

export function createSessionFileProviderFromSource(
  source: SessionFileProviderSource
): SessionFileProvider {
  switch (source.kind) {
    case 'code-collab':
      return new CodeCollabSessionFileProvider({
        runtime: source.runtime,
        role: source.role,
        ...(source.sourceState === undefined ? {} : { sourceState: source.sourceState }),
        ...(source.historicalTurnId === undefined
          ? {}
          : { historicalTurnId: source.historicalTurnId }),
        ...(source.cache === undefined ? {} : { cache: source.cache }),
      });
    case 'none':
      return new UnavailableSessionFileProvider(source.message);
  }
  return assertNever(source);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled session file provider source: ${String(value)}`);
}

export class UnavailableSessionFileProvider implements SessionFileProvider {
  readonly kind = 'none';

  constructor(private readonly message = 'No file provider is available') {}

  getState(): SessionFileProviderState {
    return {
      kind: this.kind,
      ready: false,
      sourceState: 'degraded',
      message: this.message,
    };
  }

  async listFiles(): Promise<readonly SessionFileProviderEntry[]> {
    return [];
  }

  async searchFiles(_query: string): Promise<readonly SessionFileProviderEntry[]> {
    return [];
  }

  async getFile(_pathOrFileId: string): Promise<SessionFileProviderEntry | null> {
    return null;
  }

  async openFile(
    _pathOrFileId: string,
    _mode?: SessionFileProviderMode
  ): Promise<SessionFileOpenResult> {
    return {
      status: 'unavailable',
      reason: 'metadata-only',
      message: this.message,
    };
  }

  async saveText(_pathOrFileId: string, _text: string): Promise<SessionFileOpenResult> {
    return {
      status: 'unavailable',
      reason: 'permission-denied',
      message: this.message,
    };
  }

  async getDiff(pathOrFileId: string): Promise<SessionFileDiffResult> {
    return {
      status: 'unavailable',
      path: pathOrFileId,
      reason: 'metadata-only',
      message: this.message,
    };
  }

  async listChangedFiles(): Promise<SessionFileChangedFilesResult> {
    return {
      status: 'unavailable',
      reason: 'metadata-only',
      message: this.message,
    };
  }
}
