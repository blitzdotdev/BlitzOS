import { useEffect, useState } from 'react';
import type { ControlPlaneClient } from '../api';
import {
  clearTemplateConnectDraft,
  hasConnectReturn,
  readTemplateConnectDraft,
  storeTemplateConnectDraft,
  templateConnectReturnTo,
} from '../connect-drafts';
import { EMPTY_WORKSPACE_ENVIRONMENT } from '../EnvironmentEditor';

/** Owns the template fields that cross the GitHub full-page redirect. The
 * screen still owns rendering and save behavior; this hook only seeds, loads,
 * and snapshots its one draft source of truth. */
export function useTemplateConnectDraft(
  client: Pick<ControlPlaneClient, 'listWorkspaceTemplates'>,
  editTemplateId: string | undefined,
  onError: (message: string) => void,
) {
  const connectReturnTo = templateConnectReturnTo(editTemplateId);
  const returningFromConnect = hasConnectReturn();
  const [restoredDraft] = useState(() => readTemplateConnectDraft(connectReturnTo));
  const [name, setName] = useState(restoredDraft?.name ?? '');
  const [machineTypeId, setMachineTypeId] = useState(restoredDraft?.machineTypeId ?? '');
  const [attachedIds, setAttachedIds] = useState<Set<string>>(
    new Set(restoredDraft?.attachedIds ?? []),
  );
  const [shareWithOrg, setShareWithOrg] = useState(restoredDraft?.shareWithOrg ?? true);
  const [templateConnections, setTemplateConnections] = useState(new Map(
    restoredDraft?.connections.map((connection) => [connection.provider, connection]),
  ));
  const [environment, setEnvironment] = useState(
    restoredDraft?.environment ?? EMPTY_WORKSPACE_ENVIRONMENT,
  );
  const [loadedEnvironment, setLoadedEnvironment] = useState(
    editTemplateId === undefined
      ? restoredDraft?.environment ?? EMPTY_WORKSPACE_ENVIRONMENT
      : null,
  );
  const [agentRuleId, setAgentRuleId] = useState<string | null>(restoredDraft?.agentRuleId ?? null);
  const [isOrgDefault, setIsOrgDefault] = useState(restoredDraft?.isOrgDefault ?? false);
  const [repos, setRepos] = useState<string[]>(restoredDraft?.repos ?? []);

  useEffect(() => {
    if (returningFromConnect) clearTemplateConnectDraft(connectReturnTo);
  }, [connectReturnTo, returningFromConnect]);

  useEffect(() => {
    if (editTemplateId === undefined) return;
    let mounted = true;
    void client.listWorkspaceTemplates().then(({ templates }) => {
      if (!mounted) return;
      const existing = templates.find(({ id }) => id === editTemplateId);
      if (existing === undefined) {
        onError('That template no longer exists.');
        return;
      }
      setName(restoredDraft?.name ?? existing.name);
      setMachineTypeId(restoredDraft?.machineTypeId ?? existing.machineTypeId);
      setIsOrgDefault(restoredDraft?.isOrgDefault ?? existing.isOrgDefault);
      setRepos(restoredDraft?.repos ?? existing.repos.map(({ repo }) => repo));
      setAgentRuleId(restoredDraft?.agentRuleId ?? existing.agentRuleId);
      // Keep unreadable folder ids too. The server preserves stored folders
      // and checks only additions when the member saves the edit.
      setAttachedIds(new Set(
        restoredDraft?.attachedIds ?? existing.folders.map(({ id }) => id),
      ));
      setTemplateConnections(new Map(
        (restoredDraft?.connections ?? existing.connections)
          .map((connection) => [connection.provider, connection]),
      ));
      const stored = restoredDraft?.environment
        ?? existing.environment
        ?? EMPTY_WORKSPACE_ENVIRONMENT;
      setLoadedEnvironment(stored);
      setEnvironment(stored);
    }).catch((caught: Error) => onError(caught.message));
    return () => { mounted = false; };
  }, [client, editTemplateId, onError, restoredDraft]);

  const persistConnectDraft = () => {
    // Picked file bytes already live in Drive. Their folder ids preserve the
    // attachment without serializing bytes or inventing a second file model.
    storeTemplateConnectDraft(connectReturnTo, {
      name,
      machineTypeId,
      attachedIds: [...attachedIds],
      connections: [...templateConnections.values()],
      shareWithOrg,
      environment,
      agentRuleId,
      isOrgDefault,
      repos,
    });
  };

  return {
    connectReturnTo,
    name,
    setName,
    machineTypeId,
    setMachineTypeId,
    attachedIds,
    setAttachedIds,
    shareWithOrg,
    setShareWithOrg,
    templateConnections,
    setTemplateConnections,
    environment,
    setEnvironment,
    loadedEnvironment,
    agentRuleId,
    setAgentRuleId,
    isOrgDefault,
    setIsOrgDefault,
    repos,
    setRepos,
    persistConnectDraft,
  };
}
