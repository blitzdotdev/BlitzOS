import { describe, expect, it } from 'vitest';
import type { AcpConfigOptionSelector } from '../src/components/shared/acp-selector-options';
import {
  SESSION_ACP_CONFIG_USED_EVENT,
  buildSessionCreateAcpAnalyticsProperties,
} from '../src/lib/session-create-analytics';

const selectors: AcpConfigOptionSelector[] = [
  {
    configId: 'mode',
    label: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: 'read-only',
    options: [
      { value: 'read-only', label: 'Read Only' },
      { value: 'default', label: 'Default' },
    ],
  },
  {
    configId: 'model',
    label: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'gpt-5',
    options: [
      { value: 'gpt-5', label: 'GPT-5' },
      { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
    ],
  },
  {
    configId: 'reasoning_effort',
    label: 'Think level',
    category: 'thought_level',
    type: 'select',
    currentValue: 'medium',
    options: [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
    ],
  },
];

describe('session create analytics', () => {
  it('uses the shared provider key and explicit legacy mode/model ids', () => {
    expect(SESSION_ACP_CONFIG_USED_EVENT).toBe('session/acp_config_used');
    expect(
      buildSessionCreateAcpAnalyticsProperties({
        cliType: 'builtin',
        agentType: 'codex',
        modeId: 'default',
        modelId: 'gpt-5',
        configOptionSelectors: selectors,
        configOptionValues: {
          mode: 'read-only',
          model: 'gpt-5.2-codex',
          reasoning_effort: 'high',
        },
      })
    ).toEqual({
      acp_provider: 'builtin:codex',
      mode_id: 'default',
      mode_config_id: null,
      model_id: 'gpt-5',
      model_config_id: null,
      thinking_effort: 'high',
      thinking_effort_config_id: 'reasoning_effort',
      thinking_effort_label: 'High',
    });
  });

  it('extracts dynamic ACP model and thinking effort selector values', () => {
    expect(
      buildSessionCreateAcpAnalyticsProperties({
        cliType: 'registry',
        agentType: 'kimi',
        configOptionSelectors: selectors,
        configOptionValues: {
          mode: 'default',
          model: 'gpt-5.2-codex',
          reasoning_effort: 'low',
        },
      })
    ).toEqual({
      acp_provider: 'registry:kimi',
      mode_id: 'default',
      mode_config_id: 'mode',
      model_id: 'gpt-5.2-codex',
      model_config_id: 'model',
      thinking_effort: 'low',
      thinking_effort_config_id: 'reasoning_effort',
      thinking_effort_label: 'Low',
    });
  });

  it('falls back to selector current values when stored values are invalid', () => {
    expect(
      buildSessionCreateAcpAnalyticsProperties({
        cliType: 'builtin',
        agentType: 'codex',
        configOptionSelectors: selectors,
        configOptionValues: {
          mode: 'invalid',
          model: true,
          reasoning_effort: 'invalid',
        },
      })
    ).toEqual({
      acp_provider: 'builtin:codex',
      mode_id: 'read-only',
      mode_config_id: 'mode',
      model_id: 'gpt-5',
      model_config_id: 'model',
      thinking_effort: 'medium',
      thinking_effort_config_id: 'reasoning_effort',
      thinking_effort_label: 'Medium',
    });
  });

  it('recognizes custom thought_level selector ids', () => {
    expect(
      buildSessionCreateAcpAnalyticsProperties({
        cliType: 'registry',
        agentType: 'custom-agent',
        configOptionSelectors: [
          {
            configId: 'thought_level',
            label: 'Thought',
            category: 'thought_level',
            type: 'select',
            currentValue: 'balanced',
            options: [{ value: 'balanced', label: 'Balanced' }],
          },
        ],
      })
    ).toEqual({
      acp_provider: 'registry:custom-agent',
      mode_id: null,
      mode_config_id: null,
      model_id: null,
      model_config_id: null,
      thinking_effort: 'balanced',
      thinking_effort_config_id: 'thought_level',
      thinking_effort_label: 'Balanced',
    });
  });
});
