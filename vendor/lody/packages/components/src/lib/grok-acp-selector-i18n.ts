import type { TFunction } from 'i18next';
import type { AcpSelectorOptions } from '../components/shared/acp-selector-options';

type KnownOptionTranslation = {
  labelKey: string;
  labelFallback: string;
  descriptionKey: string;
  descriptionFallback: string;
};

const INTERACTION_MODE_OPTIONS: Record<string, KnownOptionTranslation> = {
  agent: {
    labelKey: 'chat.runConfig.grok.interaction.agent.label',
    labelFallback: 'Agent',
    descriptionKey: 'chat.runConfig.grok.interaction.agent.description',
    descriptionFallback: 'Use tools and make changes when needed',
  },
  plan: {
    labelKey: 'chat.runConfig.grok.interaction.plan.label',
    labelFallback: 'Plan',
    descriptionKey: 'chat.runConfig.grok.interaction.plan.description',
    descriptionFallback: 'Plan and reason without modifying the workspace',
  },
  ask: {
    labelKey: 'chat.runConfig.grok.interaction.ask.label',
    labelFallback: 'Ask',
    descriptionKey: 'chat.runConfig.grok.interaction.ask.description',
    descriptionFallback: 'Answer questions without modifying the workspace',
  },
};

const PERMISSION_MODE_OPTIONS: Record<string, KnownOptionTranslation> = {
  ask: {
    labelKey: 'chat.runConfig.grok.permission.ask.label',
    labelFallback: 'Ask Every Time',
    descriptionKey: 'chat.runConfig.grok.permission.ask.description',
    descriptionFallback: 'Request approval before protected actions',
  },
  auto: {
    labelKey: 'chat.runConfig.grok.permission.auto.label',
    labelFallback: 'Auto',
    descriptionKey: 'chat.runConfig.grok.permission.auto.description',
    descriptionFallback: 'Let Grok decide when approval is required (experimental)',
  },
  'always-approve': {
    labelKey: 'chat.runConfig.grok.permission.alwaysApprove.label',
    labelFallback: 'Always Approve',
    descriptionKey: 'chat.runConfig.grok.permission.alwaysApprove.description',
    descriptionFallback: 'Approve protected actions automatically',
  },
};

const translateOption = (
  t: TFunction,
  option: AcpSelectorOptions['configOptionSelectors'][number]['options'][number],
  translation: KnownOptionTranslation | undefined
) =>
  translation
    ? {
        ...option,
        label: t(translation.labelKey, translation.labelFallback),
        description: t(translation.descriptionKey, translation.descriptionFallback),
      }
    : option;

/** Localizes only the Lody-owned compatibility options synthesized for builtin Grok. */
export const localizeBuiltinGrokSelectorOptions = (
  options: AcpSelectorOptions,
  t: TFunction
): AcpSelectorOptions => ({
  ...options,
  configOptionSelectors: options.configOptionSelectors.map((selector) => {
    if (selector.type === 'select' && selector.configId === 'interaction_mode') {
      return {
        ...selector,
        label: t('chat.runConfig.grok.interaction.label', 'Interaction Mode'),
        description: t(
          'chat.runConfig.grok.interaction.description',
          'Controls whether Grok acts, plans, or answers read-only questions'
        ),
        options: selector.options.map((option) =>
          translateOption(t, option, INTERACTION_MODE_OPTIONS[option.value])
        ),
      };
    }
    if (selector.type === 'select' && selector.configId === 'permission_mode') {
      return {
        ...selector,
        label: t('chat.runConfig.grok.permission.label', 'Permission Mode'),
        description: t(
          'chat.runConfig.grok.permission.description',
          'Controls how protected tool actions are approved'
        ),
        options: selector.options.map((option) =>
          translateOption(t, option, PERMISSION_MODE_OPTIONS[option.value])
        ),
      };
    }
    return selector;
  }),
});
