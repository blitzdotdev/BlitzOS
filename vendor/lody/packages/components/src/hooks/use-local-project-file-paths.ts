import { useEffect, useState } from 'react';
import i18next from 'i18next';
import { useAtomValue } from 'jotai';
import type { LocalProjectId, MachineId, WorkspaceId } from '@lody/shared';
import { runtimeAtom, userAtom } from '@/atoms';
import { localCliStartingAtom, localMachineIdAtom } from '@/atoms/local-probe';
import {
  createLocalProjectIpcFileTransport,
  createLocalProjectRpcFileTransport,
} from '@/lib/local-project-rpc-file-provider';
import { getIpcServices } from '@/lib/electron-ipc-client';
import { useIpcClient } from '@/providers/ipc-client-provider';

export type LocalProjectFilePathsEntry = {
  paths: string[];
  truncated: boolean;
  fetchedAt: number;
};

export type LocalProjectFilePathsStatus = 'idle' | 'loading' | 'ready' | 'refreshing' | 'error';

export type LocalProjectFilePathsState = {
  entry: LocalProjectFilePathsEntry | null;
  status: LocalProjectFilePathsStatus;
  error?: string;
};

type LocalProjectFilePathsLoadResult = { paths: string[]; truncated: boolean };

const LOCAL_PROJECT_CACHE_TTL_MS = 60_000;
const LOCAL_PROJECT_MAX_FILES = 80_000;
const localProjectPathsCache = new Map<string, LocalProjectFilePathsEntry>();
const localProjectPathsInFlight = new Map<string, Promise<LocalProjectFilePathsLoadResult>>();

const isEntryStale = (entry: LocalProjectFilePathsEntry, now: number): boolean =>
  now - entry.fetchedAt > LOCAL_PROJECT_CACHE_TTL_MS;

export type LocalProjectFilePathsSource =
  | {
      kind: 'project';
      workspaceId: string;
      machineId?: string;
      localProjectId: string;
    }
  | {
      kind: 'worktree';
      repoKey: string;
      sessionId: string;
    };

type LocalProjectFilePathsInput = LocalProjectFilePathsSource | string | undefined;

export type UseLocalProjectFilePathsOptions = {
  /**
   * Forces a fresh file-list request when the token changes. This is used by live
   * session surfaces where the local filesystem can change while the panel stays mounted.
   */
  refreshToken?: string | number | null;
  refreshOnMount?: boolean;
};

function normalizeSource(input: LocalProjectFilePathsInput): LocalProjectFilePathsSource | null {
  if (!input) {
    return null;
  }

  if (typeof input === 'string') {
    return null;
  }

  if (input.kind === 'project') {
    const workspaceId = input.workspaceId.trim();
    const machineId = input.machineId?.trim();
    const localProjectId = input.localProjectId.trim();
    return workspaceId && localProjectId
      ? { kind: 'project', workspaceId, ...(machineId ? { machineId } : {}), localProjectId }
      : null;
  }

  const repoKey = input.repoKey.trim();
  const sessionId = input.sessionId.trim();
  if (!repoKey || !sessionId) {
    return null;
  }
  return {
    kind: 'worktree',
    repoKey,
    sessionId,
  };
}

export function useLocalProjectFilePaths(
  sourceInput?: LocalProjectFilePathsInput,
  options: UseLocalProjectFilePathsOptions = {}
): LocalProjectFilePathsState {
  const ipcClient = useIpcClient();
  const runtime = useAtomValue(runtimeAtom);
  const requestedByUserId = useAtomValue(userAtom)?.id ?? null;
  const localMachineId = useAtomValue(localMachineIdAtom);
  const localCliStarting = useAtomValue(localCliStartingAtom);
  const [state, setState] = useState<LocalProjectFilePathsState>({ entry: null, status: 'idle' });
  const source = normalizeSource(sourceInput);
  const sourceKind = source?.kind ?? null;
  const sourceWorkspaceId = source?.kind === 'project' ? source.workspaceId : null;
  const sourceMachineId = source?.kind === 'project' ? (source.machineId ?? null) : null;
  const sourceLocalProjectId = source?.kind === 'project' ? source.localProjectId : null;
  const sourceRepoKey = source?.kind === 'worktree' ? source.repoKey : null;
  const sourceSessionId = source?.kind === 'worktree' ? source.sessionId : null;
  const refreshToken = options.refreshToken ?? null;
  const refreshOnMount = options.refreshOnMount ?? false;

  useEffect(() => {
    if (!sourceKind) {
      setState({ entry: null, status: 'idle' });
      return undefined;
    }

    if (typeof window === 'undefined') {
      setState({ entry: null, status: 'idle' });
      return undefined;
    }

    const localProjects = getIpcServices(ipcClient)?.localProjects;
    const listLocalProjectFiles = localProjects?.listFiles.bind(localProjects);
    const listSessionWorktreeFiles = localProjects?.listSessionWorktreeFiles.bind(localProjects);
    let cacheKey = '';
    let loadFiles: (() => Promise<LocalProjectFilePathsLoadResult>) | null = null;

    if (sourceKind === 'project') {
      if (!sourceWorkspaceId || !sourceLocalProjectId) {
        setState({ entry: null, status: 'idle' });
        return undefined;
      }
      const canUseLocalProjectIpc =
        Boolean(listLocalProjectFiles) && (!sourceMachineId || sourceMachineId === localMachineId);
      // Timing guard: the local desktop CLI advertises its machineId (which flips
      // `canUseLocalProjectIpc`) before its workspace runtimes finish booting.
      // Sending file-list requests in that window throws "Local workspace runtime
      // is unavailable", so wait — show a loading state — while the CLI is still
      // starting. The effect re-runs when `localCliStarting` clears and fetches
      // then (or, if the CLI never comes up, falls through to the error path).
      if (canUseLocalProjectIpc && localCliStarting) {
        setState((prev) => ({
          entry: prev.entry,
          status: prev.entry ? 'refreshing' : 'loading',
        }));
        return undefined;
      }
      if (!canUseLocalProjectIpc && (!runtime || !requestedByUserId || !sourceMachineId)) {
        setState({
          entry: null,
          status: 'error',
          error: i18next.t('sessions.localProject.files.apiUnavailable'),
        });
        return undefined;
      }
      cacheKey = `project:${sourceWorkspaceId}:${sourceMachineId ?? 'local'}:${sourceLocalProjectId}`;
      loadFiles = async () => {
        if (canUseLocalProjectIpc) {
          return await createLocalProjectIpcFileTransport({
            workspaceId: sourceWorkspaceId as WorkspaceId,
            localProjectId: sourceLocalProjectId as LocalProjectId,
            ipcClient,
          }).listFiles({ maxFiles: LOCAL_PROJECT_MAX_FILES });
        }
        if (!runtime || !requestedByUserId || !sourceMachineId) {
          throw new Error(i18next.t('sessions.localProject.files.apiUnavailable'));
        }
        return await createLocalProjectRpcFileTransport({
          workspaceId: sourceWorkspaceId as WorkspaceId,
          machineId: sourceMachineId as MachineId,
          localProjectId: sourceLocalProjectId as LocalProjectId,
          requestedByUserId,
          requestLocalProjectControl: (request, requestOptions) =>
            runtime.requestLocalProjectControl(request, requestOptions),
        }).listFiles({ maxFiles: LOCAL_PROJECT_MAX_FILES });
      };
    } else {
      if (!sourceRepoKey || !sourceSessionId) {
        setState({ entry: null, status: 'idle' });
        return undefined;
      }
      if (!listSessionWorktreeFiles) {
        setState({
          entry: null,
          status: 'error',
          error: i18next.t('sessions.localProject.files.apiUnavailable'),
        });
        return undefined;
      }
      cacheKey = `worktree:${sourceRepoKey}:${sourceSessionId}`;
      loadFiles = () =>
        listSessionWorktreeFiles(sourceRepoKey, sourceSessionId, {
          maxFiles: LOCAL_PROJECT_MAX_FILES,
        });
    }

    let cancelled = false;
    const now = Date.now();
    const cacheEntry = localProjectPathsCache.get(cacheKey);
    const forceRefresh = refreshOnMount || refreshToken !== null;

    if (cacheEntry) {
      setState({
        entry: cacheEntry,
        status: forceRefresh || isEntryStale(cacheEntry, now) ? 'refreshing' : 'ready',
      });
    } else {
      setState({ entry: null, status: 'loading' });
    }

    if (cacheEntry && !forceRefresh && !isEntryStale(cacheEntry, now)) {
      return undefined;
    }

    if (!loadFiles) {
      return undefined;
    }

    let inFlight = localProjectPathsInFlight.get(cacheKey);
    if (!inFlight) {
      inFlight = loadFiles().finally(() => {
        localProjectPathsInFlight.delete(cacheKey);
      });
      localProjectPathsInFlight.set(cacheKey, inFlight);
    }

    void inFlight
      .then((result) => {
        if (cancelled) return;
        const nextEntry: LocalProjectFilePathsEntry = {
          paths: result.paths,
          truncated: result.truncated,
          fetchedAt: Date.now(),
        };
        localProjectPathsCache.set(cacheKey, nextEntry);
        setState({ entry: nextEntry, status: 'ready' });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const rawMessage = error instanceof Error ? error.message : String(error);
        // Electron IPC wraps errors with "Error invoking remote method '...': Error: ..."
        const ipcPrefix = /^Error invoking remote method '[^']*':\s*Error:\s*/;
        const errorCode = rawMessage.replace(ipcPrefix, '');
        const message =
          errorCode === 'cli_not_running'
            ? i18next.t('sessions.localProject.files.cliNotRunning')
            : errorCode || i18next.t('sessions.localProject.files.loadFailed');
        setState((prev) => ({
          entry: prev.entry,
          status: 'error',
          error: message,
        }));
      });

    return () => {
      cancelled = true;
    };
  }, [
    sourceKind,
    ipcClient,
    sourceWorkspaceId,
    sourceMachineId,
    sourceLocalProjectId,
    sourceRepoKey,
    sourceSessionId,
    refreshToken,
    refreshOnMount,
    localMachineId,
    localCliStarting,
    requestedByUserId,
    runtime,
  ]);

  return state;
}
