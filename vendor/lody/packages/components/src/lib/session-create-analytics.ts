import {
  getLocalProjectHistoryProviderKey,
  type AcpConfigOptionValue,
  type AgentConfigCliType,
  type AgentType,
} from '@lody/shared';
import {
  isThoughtLevelSelector,
  resolveConfigOptionValue,
  type AcpConfigOptionSelector,
  type AcpSelectConfigOptionSelector,
} from '@/components/shared/acp-selector-options';

export const SESSION_ACP_CONFIG_USED_EVENT = 'session/acp_config_used';

export type SessionCreateAcpAnalyticsProperties = {
  acp_provider: string | null;
  mode_id: string | null;
  mode_config_id: string | null;
  model_id: string | null;
  model_config_id: string | null;
  thinking_effort: AcpConfigOptionValue | null;
  thinking_effort_config_id: string | null;
  thinking_effort_label: string | null;
};

type BuildSessionCreateAcpAnalyticsPropertiesArgs = {
  cliType?: AgentConfigCliType | null;
  agentType?: AgentType | null;
  modeId?: string | null;
  modelId?: string | null;
  configOptionValues?: Record<string, AcpConfigOptionValue> | null;
  configOptionSelectors?: readonly AcpConfigOptionSelector[] | null;
};

const resolveAcpConfigOptionValue = (
  selector: AcpConfigOptionSelector | undefined,
  value: AcpConfigOptionValue | undefined
): AcpConfigOptionValue | null => (selector ? resolveConfigOptionValue(selector, value) : null);

const resolveSelectOptionLabel = (
  selector: AcpConfigOptionSelector | undefined,
  value: AcpConfigOptionValue | null
): string | null => {
  if (!selector || selector.type !== 'select' || typeof value !== 'string') {
    return null;
  }
  return selector.options.find((option) => option.value === value)?.label ?? null;
};

const firstSelectSelector = (
  selectors: readonly AcpConfigOptionSelector[],
  predicate: (selector: AcpConfigOptionSelector) => boolean
): AcpSelectConfigOptionSelector | undefined =>
  selectors.find(
    (selector): selector is AcpSelectConfigOptionSelector =>
      selector.type === 'select' && predicate(selector)
  );

export function buildSessionCreateAcpAnalyticsProperties({
  cliType,
  agentType,
  modeId,
  modelId,
  configOptionValues,
  configOptionSelectors,
}: BuildSessionCreateAcpAnalyticsPropertiesArgs): SessionCreateAcpAnalyticsProperties {
  const selectors = configOptionSelectors ?? [];
  const modeSelector = firstSelectSelector(selectors, (selector) => selector.category === 'mode');
  const modelSelector = firstSelectSelector(selectors, (selector) => selector.category === 'model');
  const thinkingSelector = selectors.find(isThoughtLevelSelector);
  const getConfigOptionValue = (
    selector: AcpConfigOptionSelector | undefined
  ): AcpConfigOptionValue | undefined =>
    selector ? configOptionValues?.[selector.configId] : undefined;

  const resolvedModeId =
    modeId ?? resolveAcpConfigOptionValue(modeSelector, getConfigOptionValue(modeSelector));
  const resolvedModelId =
    modelId ?? resolveAcpConfigOptionValue(modelSelector, getConfigOptionValue(modelSelector));
  const resolvedThinkingEffort = resolveAcpConfigOptionValue(
    thinkingSelector,
    getConfigOptionValue(thinkingSelector)
  );

  return {
    acp_provider:
      cliType && agentType ? getLocalProjectHistoryProviderKey({ cliType, agentType }) : null,
    mode_id: typeof resolvedModeId === 'string' ? resolvedModeId : null,
    mode_config_id: modeId ? null : (modeSelector?.configId ?? null),
    model_id: typeof resolvedModelId === 'string' ? resolvedModelId : null,
    model_config_id: modelId ? null : (modelSelector?.configId ?? null),
    thinking_effort: resolvedThinkingEffort,
    thinking_effort_config_id: thinkingSelector?.configId ?? null,
    thinking_effort_label: resolveSelectOptionLabel(thinkingSelector, resolvedThinkingEffort),
  };
}
