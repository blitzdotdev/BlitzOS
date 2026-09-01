import { describe, expect, it } from 'vitest';
import {
  getReviewerConfigScanPrefix,
  isMachineReviewerConfigUsable,
  parseMachineReviewerConfig,
  parseReviewerConfigKey,
  reviewerConfigKeys,
  type AgentConfigId,
  type MachineId,
  type MachineReviewerConfig,
} from '../src';

const MACHINE_A = 'machine-a' as MachineId;
const MACHINE_B = 'machine-b' as MachineId;
const AGENT_A = 'agent-a' as AgentConfigId;
const AGENT_B = 'agent-b' as AgentConfigId;

const configuredReviewer: MachineReviewerConfig = {
  machineId: MACHINE_A,
  reviewer: {
    agentConfigId: AGENT_A,
    agentType: 'codex',
    modeId: 'plan',
    modelId: 'gpt-5.4',
    configOptionValues: {
      reasoning_effort: 'high',
      'fast-mode': false,
    },
  },
  updatedAt: 42,
};

describe('machine reviewer configuration', () => {
  it('round-trips an exact agent config and all ACP option value types', () => {
    expect(parseMachineReviewerConfig(configuredReviewer)).toEqual(configuredReviewer);
  });

  it('rejects the old agent-type-only shape as an incomplete machine configuration', () => {
    expect(
      parseMachineReviewerConfig({
        machineId: MACHINE_A,
        reviewer: { agentType: 'codex' },
        updatedAt: 42,
      })
    ).toBeUndefined();
  });

  it('keys one reviewer row per machine', () => {
    expect(reviewerConfigKeys.machine(MACHINE_A)).toEqual(['reviewer', MACHINE_A]);
    expect(getReviewerConfigScanPrefix()).toEqual(['reviewer']);
    expect(parseReviewerConfigKey(['reviewer', MACHINE_A])).toBe(MACHINE_A);
    expect(parseReviewerConfigKey(['reviewer'])).toBeUndefined();
    expect(parseReviewerConfigKey(['run', MACHINE_A])).toBeUndefined();
  });

  it('is usable only while the exact id, machine, and agent type still match', () => {
    const exactAgent = { id: AGENT_A, machineId: MACHINE_A, agentType: 'codex' };
    expect(isMachineReviewerConfigUsable(configuredReviewer, MACHINE_A, [exactAgent])).toBe(true);

    expect(
      isMachineReviewerConfigUsable(configuredReviewer, MACHINE_A, [
        { id: AGENT_B, machineId: MACHINE_A, agentType: 'codex' },
      ])
    ).toBe(false);
    expect(
      isMachineReviewerConfigUsable(configuredReviewer, MACHINE_A, [
        { id: AGENT_A, machineId: MACHINE_B, agentType: 'codex' },
      ])
    ).toBe(false);
    expect(
      isMachineReviewerConfigUsable(configuredReviewer, MACHINE_A, [
        { id: AGENT_A, machineId: MACHINE_A, agentType: 'claude' },
      ])
    ).toBe(false);
  });
});
