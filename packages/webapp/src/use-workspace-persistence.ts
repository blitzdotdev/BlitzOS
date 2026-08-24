import type { WorkspaceSessionView } from '@blitzos/schema';
import { useEffect, useRef, useState } from 'react';
import { ApiAdapter } from './api-adapter.js';
import type { Agent } from './protocol.js';
import {
  defaultWorkspaceFiles,
  defaultWorkspaceTabs,
  defaultWorkspaceWebAppState,
  normalizedWorkspaceTabs,
  workspaceWebAppState,
  type WorkspaceFiles,
  type WorkspaceTab,
  type WorkspaceTabs,
  type WorkspaceWebAppStateV1,
} from './storage.js';

export type PersistedWorkspaceTabs = {
  workspaceId: string;
  value: WorkspaceTabs;
  loaded: boolean;
};

export type PersistedWorkspaceSessions = {
  workspaceId: string;
  value: WorkspaceSessionView[];
};

interface WorkspacePersistenceMetadata {
  title: string;
  serverName: string;
  agentDefault: Agent;
  /** A viewer owns a personal view document but may not create or mutate the
   * shared terminal/chat sessions that document references. */
  canCreateSessions: boolean;
}

function sharedTab(session: WorkspaceSessionView, id: number): WorkspaceTab {
  if (session.kind !== 'chat') return { id, type: session.kind, sessionId: session.id };
  const tab: Extract<WorkspaceTab, { type: 'chat' }> = {
    id,
    type: 'chat',
    sessionId: session.id,
  };
  if (session.chatSessionId !== null) tab.chatSessionId = session.chatSessionId;
  if (session.chatProvider !== null) tab.chatProvider = session.chatProvider;
  return tab;
}

function initialWorkspaceView(sessions: readonly WorkspaceSessionView[]): WorkspaceWebAppStateV1 {
  const state = defaultWorkspaceWebAppState();
  const first = sessions[0];
  if (first !== undefined) {
    return {
      ...state,
      tabs: {
        ...state.tabs,
        tabs: state.tabs.tabs.map((tab) => tab.id === 1 ? sharedTab(first, tab.id) : tab),
      },
    };
  }
  // A viewer can reach a workspace before an editor has opened its first
  // shared session. Keep Files usable without inventing a terminal key that
  // could collide with a later server-created session.
  return {
    ...state,
    tabs: normalizedWorkspaceTabs({
      ...state.tabs,
      tabs: state.tabs.tabs.filter((tab) => tab.type === 'panel'),
      activeId: null,
    }),
  };
}

function hydratedWorkspaceView(
  doc: WorkspaceWebAppStateV1,
  sessions: readonly WorkspaceSessionView[],
): WorkspaceWebAppStateV1 {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const tabs = doc.tabs.tabs.flatMap((tab): WorkspaceTab[] => {
    if (!("sessionId" in tab) || tab.sessionId === undefined) return [tab];
    const session = byId.get(tab.sessionId);
    // Archived sessions are absent from the active registry. Dropping a stale
    // reference here keeps the personal view valid and prevents it from
    // repeatedly failing revision-checked saves after another editor archives
    // the shared session.
    if (session === undefined || session.kind !== tab.type) return [];
    if (tab.type !== 'chat') return [tab];
    return [{
      ...tab,
      ...(session.chatSessionId === null
        ? { chatSessionId: undefined }
        : { chatSessionId: session.chatSessionId }),
      ...(session.chatProvider === null
        ? { chatProvider: undefined }
        : { chatProvider: session.chatProvider }),
    }];
  });
  return {
    ...doc,
    tabs: normalizedWorkspaceTabs({
      ...doc.tabs,
      tabs,
    }),
  };
}

export function useWorkspacePersistence(
  api: ApiAdapter,
  enabled: boolean,
  activeWorkspaceId: string,
  metadata: WorkspacePersistenceMetadata | null,
  onError: (cause: Error) => void,
) {
  const [workspaceTabs, setWorkspaceTabs] = useState<PersistedWorkspaceTabs>(() => ({
    workspaceId: '',
    value: defaultWorkspaceTabs(),
    loaded: false,
  }));
  const [workspaceFiles, setWorkspaceFiles] = useState<{
    workspaceId: string;
    value: WorkspaceFiles;
  }>(() => ({ workspaceId: '', value: defaultWorkspaceFiles() }));
  const [workspaceSessions, setWorkspaceSessions] = useState<PersistedWorkspaceSessions>({
    workspaceId: '',
    value: [],
  });
  const [serverSeededId, setServerSeededId] = useState('');
  const generation = useRef(0);
  const revision = useRef<{ workspaceId: string; value: number }>({ workspaceId: '', value: 0 });
  const syncedDoc = useRef<{ workspaceId: string; json: string }>({ workspaceId: '', json: '' });
  const queuedDoc = useRef<{ workspaceId: string; json: string }>({ workspaceId: '', json: '' });
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const canCreateSessions = metadata?.canCreateSessions === true;

  useEffect(() => {
    const currentGeneration = generation.current + 1;
    generation.current = currentGeneration;
    setServerSeededId('');
    revision.current = { workspaceId: '', value: 0 };
    syncedDoc.current = { workspaceId: '', json: '' };
    queuedDoc.current = { workspaceId: '', json: '' };
    if (!enabled || !activeWorkspaceId) {
      setWorkspaceTabs({
        workspaceId: activeWorkspaceId,
        value: defaultWorkspaceTabs(),
        loaded: false,
      });
      setWorkspaceFiles({ workspaceId: '', value: defaultWorkspaceFiles() });
      setWorkspaceSessions({ workspaceId: '', value: [] });
      return;
    }
    let active = true;
    setWorkspaceTabs({
      workspaceId: activeWorkspaceId,
      value: defaultWorkspaceTabs(),
      loaded: false,
    });
    setWorkspaceSessions({ workspaceId: activeWorkspaceId, value: [] });
    void (async () => {
      const response = await api.getWorkspaceWebAppState(activeWorkspaceId);
      let sessions = response.sessions;
      if (response.doc === null && sessions.length === 0 && canCreateSessions) {
        const created = await api.createWorkspaceSession(activeWorkspaceId, { kind: 'claude' });
        sessions = [created.session];
      }
      const source = response.doc ?? initialWorkspaceView(sessions);
      const state = hydratedWorkspaceView(source, sessions);
      if (!active || generation.current !== currentGeneration) return;
      setWorkspaceTabs({ workspaceId: activeWorkspaceId, value: state.tabs, loaded: true });
      setWorkspaceFiles({ workspaceId: activeWorkspaceId, value: state.drawer });
      setWorkspaceSessions({ workspaceId: activeWorkspaceId, value: sessions });
      revision.current = { workspaceId: activeWorkspaceId, value: response.revision };
      // A legacy/default document becomes a personal V2 view on the first
      // authorized write. Leaving the confirmed JSON empty intentionally
      // schedules that write even though loading it was not a user edit.
      syncedDoc.current = {
        workspaceId: activeWorkspaceId,
        json: response.migratedFromV1 || response.doc === null ? '' : JSON.stringify(state),
      };
      setServerSeededId(activeWorkspaceId);
    })().catch((cause: Error) => {
      if (!active || generation.current !== currentGeneration) return;
      // Read failure is a local-only fallback. It deliberately keeps the
      // familiar default shell but never seeds or persists its numeric key.
      const state = defaultWorkspaceWebAppState();
      setWorkspaceTabs({ workspaceId: activeWorkspaceId, value: state.tabs, loaded: true });
      setWorkspaceFiles({ workspaceId: activeWorkspaceId, value: state.drawer });
      setWorkspaceSessions({ workspaceId: activeWorkspaceId, value: [] });
      onError(cause);
    });
    return () => {
      active = false;
    };
  }, [activeWorkspaceId, api, canCreateSessions, enabled, onError]);

  useEffect(() => {
    if (
      !enabled
      || !activeWorkspaceId
      || metadata === null
      || workspaceTabs.workspaceId !== activeWorkspaceId
      || workspaceFiles.workspaceId !== activeWorkspaceId
      || !workspaceTabs.loaded
      || serverSeededId !== activeWorkspaceId
    ) return;
    const doc = workspaceWebAppState(
      metadata.title,
      metadata.serverName,
      metadata.agentDefault,
      workspaceTabs.value,
      workspaceFiles.value,
    );
    const json = JSON.stringify(doc);
    if (
      (syncedDoc.current.workspaceId === activeWorkspaceId && syncedDoc.current.json === json)
      || (queuedDoc.current.workspaceId === activeWorkspaceId && queuedDoc.current.json === json)
    ) return;
    const currentGeneration = generation.current;
    const timer = window.setTimeout(() => {
      queuedDoc.current = { workspaceId: activeWorkspaceId, json };
      saveChain.current = saveChain.current.then(async () => {
        if (generation.current !== currentGeneration) return;
        try {
          const response = await api.putWorkspaceWebAppState(
            activeWorkspaceId,
            doc,
            revision.current.workspaceId === activeWorkspaceId ? revision.current.value : 0,
          );
          if (generation.current !== currentGeneration) return;
          revision.current = { workspaceId: activeWorkspaceId, value: response.revision };
          syncedDoc.current = { workspaceId: activeWorkspaceId, json };
          setWorkspaceSessions({ workspaceId: activeWorkspaceId, value: response.sessions });
        } catch (cause) {
          const error = cause instanceof Error ? cause : new Error('workspace view save failed');
          if (generation.current === currentGeneration) onError(error);
        } finally {
          if (
            generation.current === currentGeneration
            && queuedDoc.current.workspaceId === activeWorkspaceId
            && queuedDoc.current.json === json
          ) queuedDoc.current = { workspaceId: '', json: '' };
        }
      });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [
    activeWorkspaceId,
    api,
    enabled,
    metadata,
    onError,
    serverSeededId,
    workspaceFiles,
    workspaceTabs,
  ]);

  return {
    workspaceTabs,
    setWorkspaceTabs,
    workspaceFiles,
    setWorkspaceFiles,
    workspaceSessions,
    setWorkspaceSessions,
  };
}
