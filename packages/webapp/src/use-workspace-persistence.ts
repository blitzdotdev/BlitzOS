import { useEffect, useRef, useState } from 'react';
import { ApiAdapter } from './api-adapter.js';
import {
  defaultWorkspaceFiles,
  defaultWorkspaceTabs,
  defaultWorkspaceWebAppState,
  workspaceWebAppState,
  type WorkspaceFiles,
  type WorkspaceTabs,
} from './storage.js';
import type { Agent } from './protocol.js';

export type PersistedWorkspaceTabs = {
  workspaceId: string;
  value: WorkspaceTabs;
  loaded: boolean;
};

interface WorkspacePersistenceMetadata {
  title: string;
  serverName: string;
  agentDefault: Agent;
  /** Viewers read the shared doc but may not write it; saving anyway would
   * 403 on a loop for the whole session. */
  canWrite: boolean;
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
  const [serverSeededId, setServerSeededId] = useState('');
  // The doc last agreed with the server, as sent-on-the-wire JSON. The
  // workspace poll rebuilds workspace objects every 15s, which re-runs the
  // save effect; without this an idle tab would re-PUT its held snapshot on
  // every tick and — because the doc is shared and read newest-first — undo
  // whatever another account did in the meantime.
  const syncedDoc = useRef<{ workspaceId: string; json: string }>({ workspaceId: '', json: '' });

  useEffect(() => {
    setServerSeededId('');
    syncedDoc.current = { workspaceId: '', json: '' };
    if (!enabled || !activeWorkspaceId) {
      setWorkspaceTabs({
        workspaceId: activeWorkspaceId,
        value: defaultWorkspaceTabs(),
        loaded: false,
      });
      setWorkspaceFiles({ workspaceId: '', value: defaultWorkspaceFiles() });
      return;
    }
    let active = true;
    setWorkspaceTabs({
      workspaceId: activeWorkspaceId,
      value: defaultWorkspaceTabs(),
      loaded: false,
    });
    void api.getWorkspaceWebAppState(activeWorkspaceId)
      .then((response) => {
        if (!active) return;
        const state = response.doc ?? defaultWorkspaceWebAppState();
        setWorkspaceTabs({ workspaceId: activeWorkspaceId, value: state.tabs, loaded: true });
        setWorkspaceFiles({ workspaceId: activeWorkspaceId, value: state.drawer });
        // Adopting the server's doc is not an edit, so it must not echo back
        // as a write that outranks another account's newer save.
        syncedDoc.current = { workspaceId: activeWorkspaceId, json: JSON.stringify(state) };
        setServerSeededId(activeWorkspaceId);
      })
      .catch((cause: Error) => {
        if (!active) return;
        // A failed read still renders local defaults, but serverSeededId stays
        // clear: the doc is shared across the whole workspace, and persisting
        // defaults here would clobber every other account's tabs.
        setWorkspaceTabs({
          workspaceId: activeWorkspaceId,
          value: defaultWorkspaceTabs(),
          loaded: true,
        });
        setWorkspaceFiles({ workspaceId: activeWorkspaceId, value: defaultWorkspaceFiles() });
        onError(cause);
      });
    return () => {
      active = false;
    };
  }, [activeWorkspaceId, api, enabled, onError]);

  useEffect(() => {
    if (
      !enabled
      || !activeWorkspaceId
      || metadata === null
      || workspaceTabs.workspaceId !== activeWorkspaceId
      || workspaceFiles.workspaceId !== activeWorkspaceId
      || !workspaceTabs.loaded
      || serverSeededId !== activeWorkspaceId
      || !metadata.canWrite
    ) return;
    const doc = workspaceWebAppState(
      metadata.title,
      metadata.serverName,
      metadata.agentDefault,
      workspaceTabs.value,
      workspaceFiles.value,
    );
    const json = JSON.stringify(doc);
    if (syncedDoc.current.workspaceId === activeWorkspaceId && syncedDoc.current.json === json) {
      return;
    }
    const timer = window.setTimeout(() => {
      syncedDoc.current = { workspaceId: activeWorkspaceId, json };
      void api.putWorkspaceWebAppState(activeWorkspaceId, doc).catch((cause: Error) => {
        // The attempt stays recorded so a rejected doc is not re-sent on every
        // poll tick; the next real edit produces different JSON and retries.
        onError(cause);
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
  };
}
