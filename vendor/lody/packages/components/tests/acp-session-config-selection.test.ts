import { describe, expect, it } from 'vitest';
import {
  createEmptyAcpSessionConfigSelectionState,
  getAcpSessionConfigOptionValues,
  filterAcpSessionConfigOptionValues,
  reduceAcpSessionConfigSelection,
  type AcpSessionConfigSelectionAction,
  type AcpSessionConfigSelectionState,
} from '../src/lib/acp-session-config-selection';

const reconcile = (
  state: AcpSessionConfigSelectionState,
  overrides: Partial<Extract<AcpSessionConfigSelectionAction, { type: 'reconcile' }>> = {}
) =>
  reduceAcpSessionConfigSelection(state, {
    type: 'reconcile',
    targetKey: 'machine:agent',
    preferenceRevision: 'agent',
    preferences: {},
    capabilityAuthority: 'provisional',
    modeOptions: [],
    modelOptions: [{ value: 'gpt-5.5', label: '5.5' }],
    defaultModeId: null,
    defaultModelId: 'gpt-5.5',
    configOptionSelectors: [],
    ...overrides,
  });

describe('ACP session config reconciliation', () => {
  it('retains an unrecognized preference until authoritative capabilities arrive', () => {
    const provisional = reconcile(createEmptyAcpSessionConfigSelectionState(), {
      preferences: { modelId: 'gpt-5.6-sol' },
    });
    expect(provisional.model).toEqual({ value: 'gpt-5.6-sol', origin: 'preference' });

    const authoritative = reconcile(provisional, {
      preferences: { modelId: 'gpt-5.6-sol' },
      capabilityAuthority: 'authoritative',
      modelOptions: [
        { value: 'gpt-5.6-sol', label: '5.6 Sol' },
        { value: 'gpt-5.5', label: '5.5' },
      ],
      defaultModelId: 'gpt-5.6-sol',
    });
    expect(authoritative.model).toEqual({ value: 'gpt-5.6-sol', origin: 'preference' });
  });

  it('replaces an invalid preference only after authoritative validation', () => {
    const provisional = reconcile(createEmptyAcpSessionConfigSelectionState(), {
      preferences: { modelId: 'removed-model' },
    });
    const authoritative = reconcile(provisional, {
      preferences: { modelId: 'removed-model' },
      capabilityAuthority: 'authoritative',
    });
    expect(authoritative.model).toEqual({ value: 'gpt-5.5', origin: 'fallback' });
  });

  it('updates provisional fallbacks but preserves explicit user selections', () => {
    const provisional = reconcile(createEmptyAcpSessionConfigSelectionState());
    const withRuntimeDefault = reconcile(provisional, {
      capabilityAuthority: 'authoritative',
      modelOptions: [
        { value: 'gpt-5.6-sol', label: '5.6 Sol' },
        { value: 'gpt-5.5', label: '5.5' },
      ],
      defaultModelId: 'gpt-5.6-sol',
    });
    expect(withRuntimeDefault.model.value).toBe('gpt-5.6-sol');

    const userSelected = reduceAcpSessionConfigSelection(provisional, {
      type: 'select-model',
      value: 'gpt-5.5',
    });
    const reconciledUserSelection = reconcile(userSelected, {
      capabilityAuthority: 'authoritative',
      modelOptions: [
        { value: 'gpt-5.6-sol', label: '5.6 Sol' },
        { value: 'gpt-5.5', label: '5.5' },
      ],
      defaultModelId: 'gpt-5.6-sol',
    });
    expect(reconciledUserSelection.model).toEqual({ value: 'gpt-5.5', origin: 'user' });
  });

  it('keeps unknown config keys provisionally and removes them authoritatively', () => {
    const provisional = reconcile(createEmptyAcpSessionConfigSelectionState(), {
      preferences: {
        configOptionValues: { future_option: 'enabled', 'fast-mode': 'future-value' },
      },
      configOptionSelectors: [
        {
          configId: 'fast-mode',
          label: 'Fast mode',
          type: 'select',
          currentValue: 'off',
          options: [
            { value: 'off', label: 'Off' },
            { value: 'on', label: 'On' },
          ],
        },
      ],
    });
    expect(getAcpSessionConfigOptionValues(provisional)).toEqual({
      future_option: 'enabled',
      'fast-mode': 'future-value',
    });

    const authoritative = reconcile(provisional, {
      preferences: {
        configOptionValues: { future_option: 'enabled', 'fast-mode': 'future-value' },
      },
      capabilityAuthority: 'authoritative',
      configOptionSelectors: [
        {
          configId: 'fast-mode',
          label: 'Fast mode',
          type: 'select',
          currentValue: 'off',
          options: [
            { value: 'off', label: 'Off' },
            { value: 'on', label: 'On' },
          ],
        },
      ],
    });
    expect(getAcpSessionConfigOptionValues(authoritative)).toEqual({ 'fast-mode': 'off' });
  });

  it('filters values against the current selector schema', () => {
    const selectors = [
      {
        configId: 'collaboration_mode',
        label: 'Collaboration mode',
        type: 'select' as const,
        currentValue: 'default',
        options: [
          { value: 'default', label: 'Default' },
          { value: 'plan', label: 'Plan' },
        ],
      },
    ];
    expect(
      filterAcpSessionConfigOptionValues(
        { 'plan-mode': 'on', collaboration_mode: 'plan', future_option: 'enabled' },
        selectors
      )
    ).toEqual({ collaboration_mode: 'plan' });
    expect(
      filterAcpSessionConfigOptionValues(
        { 'plan-mode': 'on', collaboration_mode: 'invalid' },
        selectors
      )
    ).toEqual({});
  });
});
