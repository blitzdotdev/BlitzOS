import type { Meta, StoryObj } from '@storybook/react';
import { TooltipProvider } from '@/ui/tooltip';
import { TasksBoardView, type TaskCardData } from '@/components/tasks/tasks-board-view';

/**
 * 任务看板/列表。列 = 任务声明的 status；卡片上的实时信息（needs-you、
 * 完整性 warning）来自关联 session 与 PR，任务层不存第二份执行状态。
 */
const meta = {
  title: 'Tasks/TasksBoardView',
  component: TasksBoardView,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
  argTypes: {
    layout: {
      description: '看板（桌面默认）或紧凑列表（移动端默认）',
      control: 'radio',
      options: ['board', 'list'],
    },
  },
  decorators: [
    (Story) => (
      <TooltipProvider>
        <div className="h-[520px] bg-background">
          <Story />
        </div>
      </TooltipProvider>
    ),
  ],
} satisfies Meta<typeof TasksBoardView>;

export default meta;
type Story = StoryObj<typeof meta>;

const task = (overrides: Partial<TaskCardData> = {}): TaskCardData => ({
  taskId: overrides.taskId ?? 't1',
  title: 'Refactor the auth flow',
  status: 'backlog',
  ownerId: 'user-1',
  order: '1',
  createdAt: Date.parse('2026-01-15T00:00:00Z'),
  updatedAt: Date.parse('2026-01-20T00:00:00Z'),
  ...overrides,
});

const tasks: TaskCardData[] = [
  task({ taskId: 't1', title: 'Refactor the auth flow', ownerName: 'Zixuan' }),
  task({
    taskId: 't2',
    title: 'Assigned to an agent but missing a project',
    hasAgent: true,
    ready: false,
  }),
  task({
    taskId: 't3',
    title: 'Migrate the settings dialog',
    status: 'in_progress',
    sessionCount: 2,
    ownerName: 'Zixuan',
  }),
  task({
    taskId: 't4',
    title: 'Agent is waiting on an answer',
    status: 'in_progress',
    needsYou: true,
    sessionCount: 1,
  }),
  task({
    taskId: 't5',
    title: 'Ship the PR poller fix',
    status: 'needs_review',
    sessionCount: 1,
    prCount: 1,
    ownerName: 'Leon',
    createdAt: Date.parse('2025-08-03T00:00:00Z'),
  }),
  task({
    taskId: 't6',
    title: 'Waiting its turn behind another task',
    hasAgent: true,
    agentConfigId: 'agent-1',
    queuePosition: 2,
  }),
  task({
    taskId: 't7',
    title: 'Drop the legacy WS control plane',
    status: 'done',
    prCount: 2,
    ownerName: 'Zixuan',
    createdAt: Date.parse('2025-11-22T00:00:00Z'),
  }),
  task({
    taskId: 't9',
    title: 'Add debug trait support for loro swift',
    status: 'todo',
    ownerName: 'Leon',
    createdAt: Date.parse('2025-04-09T00:00:00Z'),
  }),
  task({
    taskId: 't10',
    title: 'A task whose owner is no longer in the workspace',
    status: 'todo',
  }),
  task({ taskId: 't8', title: 'Rewrite onboarding copy', status: 'canceled' }),
];

export const Board: Story = {
  args: {
    tasks,
    layout: 'board',
    onOpenTask: () => {},
    onQuickAdd: () => {},
  },
};

/**
 * 列表模式：每行等高、单行，尾部依次是会话/PR 计数、负责人头像、创建时间。
 * 覆盖了三种负责人状态——有头像、只有名字（取首字母）、解析不到成员（中性图标）。
 */
export const List: Story = {
  args: { ...Board.args, layout: 'list' },
};

/**
 * 空分组不再渲染。全空时看板/列表都是空白，创建靠页头的 New task
 * （以及非空分组上的 `+`）。
 */
export const Empty: Story = {
  args: { tasks: [], layout: 'board', onOpenTask: () => {}, onQuickAdd: () => {} },
};

/** 已托付给 agent 但要排队的任务显示队列位次；同一 agent 一次只做一个。 */
export const Queued: Story = {
  args: {
    tasks: tasks.filter((entry) => entry.queuePosition !== undefined),
    layout: 'list',
    onOpenTask: () => {},
    onQuickAdd: () => {},
  },
};

/** 待你处理的任务在组内浮顶，这是列表最主要的用途。 */
export const NeedsYouOnly: Story = {
  args: {
    tasks: tasks.filter((entry) => entry.needsYou),
    layout: 'list',
    onOpenTask: () => {},
    onQuickAdd: () => {},
  },
};
