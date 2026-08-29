import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import type { ProjectRef, TaskAgentRef, TaskPriority, TaskStatus } from '@lody/shared';
import type { UnifiedLocalProjectOption } from '@/components/chat/unified-project-selector';
import { TooltipProvider } from '@/ui/tooltip';
import { TaskPropertiesPanel } from '@/components/tasks/task-properties-panel';
import type { TaskAgentOption } from '@/components/tasks/task-launch-controls';

const meta = {
  title: 'Tasks/TaskPropertiesPanel',
  component: TaskPropertiesPanel,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <TooltipProvider>
        <div className="w-[16.5rem] border-l border-border/50 bg-background px-2.5 py-7">
          <Story />
        </div>
      </TooltipProvider>
    ),
  ],
} satisfies Meta<typeof TaskPropertiesPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

// Three owner shapes on purpose: an avatar, an initial-only fallback, and a
// long name that has to truncate rather than widen the rail.
const members = [
  { userId: 'u1', name: 'Zixuan Chen', image: null },
  { userId: 'u2', name: 'Leon', image: null },
  { userId: 'u3', name: 'A teammate with a very long display name', image: null },
];

const agentOption: TaskAgentOption = {
  agentConfigId: 'a1',
  name: 'Codex',
  homeName: 'MacBook Pro',
  presence: 'online',
};

const localProjects: UnifiedLocalProjectOption[] = [
  {
    key: 'm1:p1',
    machineId: 'm1' as never,
    localProjectId: 'p1' as never,
    name: 'lody',
    rootPath: '/Users/me/lody',
  },
];

const repositories = [{ fullName: 'loro-dev/lody' }];

function InteractivePanel({
  initialStatus = 'backlog',
  hasAgent = true,
  hasProject = true,
  delegated = false,
}: {
  initialStatus?: TaskStatus;
  hasAgent?: boolean;
  hasProject?: boolean;
  delegated?: boolean;
}) {
  const [status, setStatus] = useState<TaskStatus>(initialStatus);
  const [runAgent, setRunAgent] = useState<TaskAgentRef | null>(
    hasAgent ? { agentConfigId: 'a1' as never } : null
  );
  const [project, setProject] = useState<ProjectRef | null>(
    hasProject ? { kind: 'local', localProjectId: 'p1' as never } : null
  );
  const [delegatedTo, setDelegatedTo] = useState<string | null>(
    delegated ? 'Codex' : null
  );
  const [ownerId, setOwnerId] = useState('u1');
  const [priority, setPriority] = useState<TaskPriority | null>('medium');
  const [labels, setLabels] = useState<string[]>(['bug', 'feature']);

  return (
    <TaskPropertiesPanel
      status={status}
      onStatusChange={setStatus}
      ownerId={ownerId}
      members={members}
      onOwnerChange={(next) => setOwnerId(next ?? '')}
      priority={priority}
      onPriorityChange={setPriority}
      labels={labels}
      onLabelsChange={setLabels}
      agent={runAgent ? agentOption : null}
      runAgent={runAgent}
      onSelectRunAgent={setRunAgent}
      project={project}
      onSelectProject={setProject}
      localProjects={localProjects}
      repositories={repositories}
      onAddLocalProject={() => {}}
      onConnectGitRepo={() => {}}
      canRun={Boolean(runAgent) && Boolean(project)}
      onRun={() => {}}
      delegatedTo={delegatedTo}
      onToggleDelegation={() =>
        setDelegatedTo((previous) => (previous ? null : 'Codex'))
      }
    />
  );
}

export const Ready: Story = {
  args: {
    status: 'backlog',
    onStatusChange: () => {},
    ownerId: 'u1',
    members,
    onOwnerChange: () => {},
    priority: 'medium' as TaskPriority | null,
    onPriorityChange: () => {},
    labels: [],
    onLabelsChange: () => {},
    agent: agentOption,
    runAgent: { agentConfigId: 'a1' as never },
    onSelectRunAgent: () => {},
    project: { kind: 'local', localProjectId: 'p1' as never },
    onSelectProject: () => {},
    localProjects,
    repositories,
    onAddLocalProject: () => {},
    onConnectGitRepo: () => {},
    canRun: true,
    onRun: () => {},
  },
  render: () => <InteractivePanel />,
};

export const MissingSlots: Story = {
  args: {
    ...Ready.args,
    canRun: false,
    agent: null,
    runAgent: null,
    project: null,
  },
  render: () => <InteractivePanel hasAgent={false} hasProject={false} />,
};

export const Delegated: Story = {
  args: { ...Ready.args, delegatedTo: 'Codex' },
  render: () => <InteractivePanel delegated />,
};

export const InProgress: Story = {
  args: { ...Ready.args, status: 'in_progress', hasActiveSession: true },
  render: () => <InteractivePanel initialStatus="in_progress" />,
};
