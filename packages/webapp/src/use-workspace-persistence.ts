import { useEffect, useRef, useState } from 'react';
import { ApiAdapter } from './api-adapter.js';
import {
  defaultWorkspaceFiles,
  defaultWorkspaceTabs,
  defaultWorkspaceWebAppState,
  workspaceWebAppState,
  type WorkspaceFiles,
  type WorkspaceTabs,
  type WorkspaceWebAppStateV1,
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
  // The last server-acknowledged document is the rollback snapshot. The last
  // attempted JSON separately prevents a rejected write from looping on every
  // poll render while its restored snapshot is applied.
  const acknowledgedDoc = useRef<{
    workspaceId: string;
    value: WorkspaceWebAppStateV1;
    json: string;
  } | null>(null);
  const attemptedDoc = useRef<{ workspaceId: string; json: string }>({ workspaceId: '', json: '' });
  const currentDoc = useRef<{ workspaceId: string; json: string }>({ workspaceId: '', json: '' });
  const saveRequest = useRef<symbol | null>(null);
  const [saveVersion, setSaveVersion] = useState(0);

  useEffect(() => {
    setServerSeededId('');
    acknowledgedDoc.current = null;
    attemptedDoc.current = { workspaceId: '', json: '' };
    currentDoc.current = { workspaceId: '', json: '' };
    saveRequest.current = null;
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
        const json = JSON.stringify(state);
        acknowledgedDoc.current = { workspaceId: activeWorkspaceId, value: state, json };
        attemptedDoc.current = { workspaceId: activeWorkspaceId, json };
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

  if (
    metadata !== null
    && workspaceTabs.workspaceId === activeWorkspaceId
    && workspaceFiles.workspaceId === activeWorkspaceId
    && workspaceTabs.loaded
  ) {
    currentDoc.current = {
      workspaceId: activeWorkspaceId,
      json: JSON.stringify(workspaceWebAppState(
        metadata.title,
        metadata.serverName,
        metadata.agentDefault,
        workspaceTabs.value,
        workspaceFiles.value,
      )),
    };
  }

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
      || saveRequest.current !== null
    ) return;
    const doc = workspaceWebAppState(
      metadata.title,
      metadata.serverName,
      metadata.agentDefault,
      workspaceTabs.value,
      workspaceFiles.value,
    );
    const json = JSON.stringify(doc);
    if (attemptedDoc.current.workspaceId === activeWorkspaceId && attemptedDoc.current.json === json) {
      return;
    }
    const timer = window.setTimeout(() => {
      const request = Symbol(activeWorkspaceId);
      saveRequest.current = request;
      attemptedDoc.current = { workspaceId: activeWorkspaceId, json };
      void api.putWorkspaceWebAppState(activeWorkspaceId, doc)
        .then((response) => {
          if (saveRequest.current !== request) return;
          const canonical = response.doc ?? defaultWorkspaceWebAppState();
          const canonicalJson = JSON.stringify(canonical);
          acknowledgedDoc.current = {
            workspaceId: activeWorkspaceId,
            value: canonical,
            json: canonicalJson,
          };
          attemptedDoc.current = { workspaceId: activeWorkspaceId, json: canonicalJson };
          // A newer local edit waits behind this write and gets its own turn.
          if (currentDoc.current.workspaceId !== activeWorkspaceId
            || currentDoc.current.json !== json) return;
          setWorkspaceTabs((current) => current.workspaceId === activeWorkspaceId
            ? { ...current, value: canonical.tabs }
            : current);
          setWorkspaceFiles((current) => current.workspaceId === activeWorkspaceId
            ? { workspaceId: activeWorkspaceId, value: canonical.drawer }
            : current);
        })
        .catch((cause: Error) => {
          if (saveRequest.current !== request) return;
          const acknowledged = acknowledgedDoc.current;
          if (acknowledged?.workspaceId === activeWorkspaceId) {
            attemptedDoc.current = {
              workspaceId: activeWorkspaceId,
              json: acknowledged.json,
            };
            setWorkspaceTabs((current) => current.workspaceId === activeWorkspaceId
              ? { ...current, value: acknowledged.value.tabs }
              : current);
            setWorkspaceFiles((current) => current.workspaceId === activeWorkspaceId
              ? { workspaceId: activeWorkspaceId, value: acknowledged.value.drawer }
              : current);
          }
          onError(cause);
        })
        .finally(() => {
          if (saveRequest.current !== request) return;
          saveRequest.current = null;
          setSaveVersion((version) => version + 1);
        });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [
    activeWorkspaceId,
    api,
    enabled,
    metadata,
    onError,
    saveVersion,
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
