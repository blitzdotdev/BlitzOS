import {
  getLocalProjectHistoryProviderKey,
  REGISTRY_ACP_AGENTS,
  type LocalProjectHistoryProvider,
  type SessionMeta,
} from '@lody/shared';

export type RefreshableExternalHistory = NonNullable<SessionMeta['externalHistory']> & {
  provider: LocalProjectHistoryProvider;
};

export function shouldRefreshExternalHistoryOnOpen(
  externalHistory: SessionMeta['externalHistory'] | undefined
): externalHistory is RefreshableExternalHistory {
  if (!externalHistory) return false;
  return externalHistory.status !== 'sync_conflict';
}

export function getExternalHistoryProviderLabel(provider: LocalProjectHistoryProvider): string {
  if (provider.cliType === 'builtin') {
    if (provider.agentType === 'claude') return 'Claude';
    if (provider.agentType === 'codex') return 'Codex';
  }
  return (
    REGISTRY_ACP_AGENTS.find((agent) => agent.id === provider.agentType)?.name ?? provider.agentType
  );
}

export function getExternalHistoryRefreshKey(
  sessionId: string,
  externalHistory: RefreshableExternalHistory
): string {
  const providerKey = getLocalProjectHistoryProviderKey(externalHistory.provider);
  return `${sessionId}:${providerKey}:${externalHistory.sourceAcpSessionId}`;
}
