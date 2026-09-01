import type { Meta, StoryObj } from '@storybook/react';
import { TaskInboxPanel } from '@/components/tasks/task-inbox-panel';

/**
 * 未读 `@` 提醒的收件箱。数据全部来自任务索引（`mentionedUserIds` +
 * `lastCommentAt`）与本地已读位置，没有新增存储或同步。
 * 空的时候**整块不渲染** —— 一个常年在那儿却总是空的收件箱只会被无视。
 */
const meta = {
  title: 'Tasks/TaskInboxPanel',
  component: TaskInboxPanel,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="w-full max-w-[520px] bg-background p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TaskInboxPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

// Fixed so the relative labels never drift between runs.
const NOW = new Date('2026-07-27T12:00:00Z');
const minutesAgo = (n: number) => NOW.getTime() - n * 60_000;

export const Single: Story = {
  args: {
    now: NOW,
    items: [
      {
        taskId: 'task_1',
        title: 'Move session dispatch off the deprecated WS control plane',
        lastCommentAt: minutesAgo(4),
      },
    ],
    onOpenTask: () => {},
  },
};

export const Several: Story = {
  args: {
    now: NOW,
    items: [
      { taskId: 'task_1', title: 'Audit the retry path', lastCommentAt: minutesAgo(2) },
      {
        taskId: 'task_2',
        title: 'Decide whether the delegation checkbox needs a confirmation step',
        lastCommentAt: minutesAgo(95),
      },
      { taskId: 'task_3', title: 'Ship the preview double-stack fix', lastCommentAt: minutesAgo(1500) },
    ],
    onOpenTask: () => {},
  },
};

/** 长标题必须截断，而不是把时间戳挤出可视区。 */
export const LongTitle: Story = {
  args: {
    now: NOW,
    items: [
      {
        taskId: 'task_1',
        title:
          'Reconcile the PR status poller with the webhook fan-out so that CI rollup, merge state and conflict detection stop disagreeing after a force push',
        lastCommentAt: minutesAgo(9),
      },
    ],
    onOpenTask: () => {},
  },
};

/** 没有标题的任务（正文首行也空）仍要有可读的行。 */
export const UntitledTask: Story = {
  args: {
    now: NOW,
    items: [{ taskId: 'task_1', title: '   ', lastCommentAt: minutesAgo(30) }],
    onOpenTask: () => {},
  },
};

/** 空收件箱**不渲染任何东西** —— 这个 story 应该是一片空白。 */
export const Empty: Story = {
  args: { now: NOW, items: [], onOpenTask: () => {} },
};
