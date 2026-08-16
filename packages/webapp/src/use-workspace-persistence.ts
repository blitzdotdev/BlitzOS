import { useEffect, useState } from 'react';
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

  useEffect(() => {
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
      })
      .catch((cause: Error) => {
        if (!active) return;
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
    ) return;
    const timer = window.setTimeout(() => {
      void api.putWorkspaceWebAppState(
        activeWorkspaceId,
        workspaceWebAppState(
          metadata.title,
          metadata.serverName,
          metadata.agentDefault,
          workspaceTabs.value,
          workspaceFiles.value,
        ),
      ).catch(onError);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [
    activeWorkspaceId,
    api,
    enabled,
    metadata,
    onError,
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
