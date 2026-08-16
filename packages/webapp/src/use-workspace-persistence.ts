import { useEffect, useLayoutEffect, useState } from 'react';
import {
  defaultWorkspaceFiles,
  defaultWorkspaceTabs,
  loadWorkspaceFiles,
  loadWorkspaceTabs,
  saveWorkspaceFiles,
  saveWorkspaceTabs,
  type StorageNamespace,
  type WorkspaceFiles,
  type WorkspaceTabs,
} from './storage.js';

export type LocalWorkspaceTabs = {
  workspaceId: string;
  value: WorkspaceTabs;
  loaded: boolean;
};

export function useWorkspacePersistence(
  storageNamespace: StorageNamespace | null,
  activeWorkspaceId: string,
) {
  const [workspaceTabs, setWorkspaceTabs] = useState<LocalWorkspaceTabs>(() => ({
    workspaceId: '',
    value: defaultWorkspaceTabs(),
    loaded: false,
  }));
  const [workspaceFiles, setWorkspaceFiles] = useState<{
    workspaceId: string;
    value: WorkspaceFiles;
  }>(() => ({ workspaceId: '', value: defaultWorkspaceFiles() }));

  useLayoutEffect(() => {
    if (!storageNamespace || !activeWorkspaceId) {
      setWorkspaceTabs({
        workspaceId: activeWorkspaceId,
        value: defaultWorkspaceTabs(),
        loaded: false,
      });
      return;
    }
    setWorkspaceTabs({
      workspaceId: activeWorkspaceId,
      value: loadWorkspaceTabs(storageNamespace, activeWorkspaceId),
      loaded: true,
    });
  }, [activeWorkspaceId, storageNamespace]);

  useEffect(() => {
    if (
      !storageNamespace
      || !activeWorkspaceId
      || workspaceTabs.workspaceId !== activeWorkspaceId
      || !workspaceTabs.loaded
    ) return;
    saveWorkspaceTabs(storageNamespace, activeWorkspaceId, workspaceTabs.value);
  }, [activeWorkspaceId, storageNamespace, workspaceTabs]);

  useEffect(() => {
    if (!storageNamespace || !activeWorkspaceId) {
      setWorkspaceFiles({ workspaceId: '', value: defaultWorkspaceFiles() });
      return;
    }
    setWorkspaceFiles({
      workspaceId: activeWorkspaceId,
      value: loadWorkspaceFiles(storageNamespace, activeWorkspaceId),
    });
  }, [activeWorkspaceId, storageNamespace]);

  useEffect(() => {
    if (
      !storageNamespace
      || !activeWorkspaceId
      || workspaceFiles.workspaceId !== activeWorkspaceId
    ) return;
    saveWorkspaceFiles(storageNamespace, activeWorkspaceId, workspaceFiles.value);
  }, [activeWorkspaceId, storageNamespace, workspaceFiles]);

  return {
    workspaceTabs,
    setWorkspaceTabs,
    workspaceFiles,
    setWorkspaceFiles,
  };
}
