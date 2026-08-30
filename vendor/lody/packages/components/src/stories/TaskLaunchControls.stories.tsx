import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { TooltipProvider } from '@/ui/tooltip';
import { TaskLaunchControls } from '@/components/tasks/task-launch-controls';

/**
 * Run 按钮 + 槽位链。槽位是 agent-first：先选「谁来做」，机器只是这位 agent 的
 * 工位（次要文本），不是用户要导航的坐标。该 agent 访问不到的项目**不过滤**，
 * 而是置灰并给出原因——消失的选项无法解释自己。
 */
const meta = {
  title: 'Tasks/TaskLaunchControls',
  component: TaskLaunchControls,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <TooltipProvider>
        <div className="w-[640px] bg-background p-4">
          <Story />
        </div>
      </TooltipProvider>
    ),
  ],
} satisfies Meta<typeof TaskLaunchControls>;

export default meta;
type Story = StoryObj<typeof meta>;

const agentOptions = [
  { agentConfigId: 'a1', name: 'Design Agent', homeName: 'MacBook Pro', presence: 'online' as const },
  { agentConfigId: 'a2', name: 'Codex @ Workstation', homeName: 'Workstation', presence: 'offline' as const },
  { agentConfigId: 'a3', name: 'Kimi', homeName: 'MacBook Pro', presence: 'unknown' as const },
];

const projectOptions = [
  { key: 'local::p1', label: 'lody', machineName: 'MacBook Pro', reachable: true },
  { key: 'local::p2', label: 'loro', machineName: 'MacBook Pro', reachable: true },
  { key: 'local::p3', label: 'monorepo', machineName: 'Workstation', reachable: false },
];

const handlers = {
  onSelectAgent: () => {},
  onSelectProject: () => {},
  onRun: () => {},
};

export const Ready: Story = {
  args: {
    ...handlers,
    agent: agentOptions[0],
    agentOptions,
    project: projectOptions[0],
    projectOptions,
    canRun: true,
  },
};

/** 缺槽位时 Run 不灰掉——点击后原地补齐，而不是先禁用再让用户猜。 */
export const MissingSlots: Story = {
  args: {
    ...handlers,
    agent: null,
    agentOptions,
    project: null,
    projectOptions,
    canRun: false,
  },
};

/** 离线文案自带解释：协作者不知道这个 agent 住在哪台机器上。 */
export const AgentOffline: Story = {
  args: {
    ...handlers,
    agent: agentOptions[1],
    agentOptions,
    project: projectOptions[0],
    projectOptions,
    canRun: true,
  },
};

/** presence 未同步时显示为 unknown，不得画成离线。 */
export const PresenceUnknown: Story = {
  args: {
    ...handlers,
    agent: agentOptions[2],
    agentOptions,
    project: projectOptions[0],
    projectOptions,
    canRun: true,
  },
};

/** 已有 session 在跑：Run 降为次级，防误双开。 */
export const AlreadyRunning: Story = {
  args: { ...Ready.args, hasActiveSession: true },
};

export const Starting: Story = {
  args: { ...Ready.args, running: true },
};

/** 委派开关：与上面的 agent picker 是两个动作——选谁跑一次 ≠ 托付给它自己跑。 */
export const DelegationOff: Story = {
  args: {
    ...handlers,
    agent: agentOptions[0],
    agentOptions,
    project: projectOptions[0],
    projectOptions,
    canRun: true,
    delegatedTo: null,
    onToggleDelegation: () => {},
  },
};

export const DelegationOn: Story = {
  args: {
    ...handlers,
    agent: agentOptions[0],
    agentOptions,
    project: projectOptions[0],
    projectOptions,
    canRun: true,
    delegatedTo: 'Design Agent',
    onToggleDelegation: () => {},
  },
};

/** 可交互：切换委派，确认「选谁跑」与「交给它自己跑」是两个独立状态。 */
export const DelegationInteractive: Story = {
  args: {
    ...handlers,
    agent: agentOptions[0],
    agentOptions,
    project: projectOptions[0],
    projectOptions,
    canRun: true,
  },
  render: function DelegationInteractiveStory() {
    const [delegated, setDelegated] = useState(false);
    return (
      <div className="flex flex-col gap-2">
        <TaskLaunchControls
          {...handlers}
          agent={agentOptions[0] ?? null}
          agentOptions={agentOptions}
          project={projectOptions[0] ?? null}
          projectOptions={projectOptions}
          canRun
          delegatedTo={delegated ? (agentOptions[0]?.name ?? null) : null}
          onToggleDelegation={() => setDelegated((previous) => !previous)}
        />
        <p className="text-xs text-muted-foreground">
          agent field: {delegated ? `set → automation may start it` : 'empty → never automated'}
        </p>
      </div>
    );
  },
};
