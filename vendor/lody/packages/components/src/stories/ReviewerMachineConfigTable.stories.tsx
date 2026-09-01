import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import {
  ACP_CAPABILITY_CACHE_VERSION,
  getAcpCapabilityCacheKey,
  type AgentConfigId,
  type AgentConfigMeta,
  type MachineId,
  type MachineReviewerConfig,
  type MachineViewMeta,
} from '@lody/shared';
import { CompactSection } from '@/components/settings/compact-layout';
import { ReviewerMachineConfigTable } from '@/components/settings/review-policy-setting';

const laptopId = 'machine-laptop' as MachineId;
const buildId = 'machine-build' as MachineId;
const offlineId = 'machine-offline' as MachineId;
const codexId = 'reviewer-codex' as AgentConfigId;
const claudeId = 'reviewer-claude' as AgentConfigId;

const codexConfig: AgentConfigMeta = {
  id: codexId,
  machineId: laptopId,
  name: 'Codex',
  description: 'Built-in Codex reviewer',
  cliType: 'builtin',
  agentType: 'codex',
  env: {},
};

const claudeConfig: AgentConfigMeta = {
  id: claudeId,
  machineId: buildId,
  name: 'Claude Code',
  description: 'Built-in Claude Code reviewer',
  cliType: 'builtin',
  agentType: 'claude',
  env: {},
};

const machines: MachineViewMeta[] = [
  {
    id: laptopId,
    name: 'Zhen’s MacBook Pro',
    cliVersion: '0.72.0',
    os: 'macOS 15.5',
    sessions: [],
    raceLimits: {},
    acpCapabilities: {
      [getAcpCapabilityCacheKey(codexId)]: {
        cliType: 'builtin',
        agentType: 'codex',
        cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
        sourceVersion: 'codex@1.0.0',
        modes: [
          { id: 'plan', name: 'Plan' },
          { id: 'agent', name: 'Agent' },
        ],
        models: [
          { modelId: 'gpt-5.4', name: 'GPT-5.4' },
          { modelId: 'gpt-5.4-mini', name: 'GPT-5.4 mini' },
        ],
        configOptions: [
          {
            id: 'mode',
            name: 'Mode',
            category: 'mode',
            type: 'select',
            currentValue: 'plan',
            options: [
              { value: 'plan', name: 'Plan' },
              { value: 'agent', name: 'Agent' },
            ],
          },
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'gpt-5.4',
            options: [
              { value: 'gpt-5.4', name: 'GPT-5.4' },
              { value: 'gpt-5.4-mini', name: 'GPT-5.4 mini' },
            ],
          },
          {
            id: 'reasoning_effort',
            name: 'Reasoning',
            category: 'thought_level',
            type: 'select',
            currentValue: 'high',
            options: [
              { value: 'medium', name: 'Medium' },
              { value: 'high', name: 'High' },
              { value: 'xhigh', name: 'XHigh' },
            ],
          },
        ],
        availableCommands: [],
        fetchedAt: 1,
      },
    },
  },
  {
    id: buildId,
    name: 'Build workstation',
    cliVersion: '0.72.0',
    os: 'Ubuntu 24.04',
    sessions: [],
    raceLimits: {},
  },
  {
    id: offlineId,
    name: 'Old laptop',
    cliVersion: '0.69.0',
    os: 'Windows 11',
    sessions: [],
    raceLimits: {},
  },
];

const initialConfigs = new Map<MachineId, MachineReviewerConfig>([
  [
    laptopId,
    {
      machineId: laptopId,
      reviewer: {
        agentConfigId: codexId,
        agentType: 'codex',
        modeId: 'plan',
        modelId: 'gpt-5.4',
        configOptionValues: { reasoning_effort: 'high' },
      },
      updatedAt: 1,
    },
  ],
]);

function Harness() {
  const [reviewerConfigs, setReviewerConfigs] = useState(initialConfigs);

  return (
    <div className="w-[880px] max-w-[calc(100vw-2rem)]">
      <CompactSection
        title="Review agent"
        description="Choose the reviewer used by sessions on each machine."
      >
        <ReviewerMachineConfigTable
          machines={machines}
          agentConfigs={[codexConfig, claudeConfig]}
          reviewerConfigs={reviewerConfigs}
          onlineMachineIds={new Set([laptopId, buildId])}
          onChange={(config) =>
            setReviewerConfigs((previous) => new Map(previous).set(config.machineId, config))
          }
          onDelete={(machineId) =>
            setReviewerConfigs((previous) => {
              const next = new Map(previous);
              next.delete(machineId);
              return next;
            })
          }
          onOpenAgentSettings={() => undefined}
        />
      </CompactSection>
    </div>
  );
}

const meta = {
  title: 'Settings/ReviewerMachineConfigTable',
  component: Harness,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

export const MixedMachineStates: Story = {};

export const Dark: Story = {
  globals: { theme: 'dark' },
};
