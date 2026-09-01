import type { Meta, StoryObj } from '@storybook/react';
import type { TaskTimelineEntry } from '@lody/shared';
import { TaskThread } from '@/components/tasks/task-thread';

/**
 * 任务 thread：评论与活动同一条时间线。它是协调面而不是控制面——发帖只写一条
 * 记录，永不消耗 turn；只有 @ 某个 agent 才是把评论变成工作的显式动作，而工作
 * 发生在 session 里（评论上会留下派发标记）。
 */
const meta = {
  title: 'Tasks/TaskThread',
  component: TaskThread,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="w-[680px] bg-background p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TaskThread>;

export default meta;
type Story = StoryObj<typeof meta>;

const entries: TaskTimelineEntry[] = [
  {
    id: 'e1',
    kind: 'activity',
    actorKind: 'human',
    actorName: 'Zixuan',
    createdAt: 1,
    activityType: 'created',
  },
  {
    id: 'e2',
    kind: 'comment',
    actorKind: 'human',
    actorName: 'Zixuan',
    createdAt: 2,
    body: 'Let us keep the old endpoint alive for one release.',
  },
  {
    id: 'e3',
    kind: 'activity',
    actorKind: 'human',
    actorName: 'Zixuan',
    createdAt: 3,
    activityType: 'status_changed',
    activityData: { from: 'backlog', to: 'in_progress' },
  },
  {
    id: 'e4',
    kind: 'comment',
    actorKind: 'human',
    actorName: 'Zixuan',
    createdAt: 4,
    body: '@Codex please take the migration part.',
    agentMentions: ['a1'],
    dispatchedSessionId: 'session-1' as never,
  },
  {
    id: 'e5',
    kind: 'comment',
    actorKind: 'agent',
    actorName: 'Codex',
    createdAt: 5,
    body: 'Migration is done. Opened a pull request; CI is green.',
    originSessionId: 'session-1' as never,
  },
  {
    id: 'e6',
    kind: 'activity',
    actorKind: 'agent',
    actorName: 'Codex',
    createdAt: 6,
    activityType: 'body_edited',
    activityData: { added: '120', removed: '40' },
  },
];

export const Default: Story = {
  args: {
    entries,
    onSubmit: () => {},
    onOpenSession: () => {},
    onImagePaste: async () => undefined,
    imageAccept: 'image/png,image/jpeg,image/webp,image/gif',
  },
};

export const Empty: Story = {
  args: { entries: [], onSubmit: () => {} },
};

/** 从 body 里引用一段后，引文预置在输入框上方。 */
export const WithPendingQuote: Story = {
  args: {
    entries,
    pendingQuote: 'The old endpoint must stay until the mobile release ships.',
    onClearQuote: () => {},
    onSubmit: () => {},
    onOpenSession: () => {},
  },
};

export const Disabled: Story = {
  args: { entries, disabled: true, onSubmit: () => {} },
};

/**
 * 关联对话行：标题 + **当前执行状态**。状态读的是 session 自己的事实（任务层
 * 不存执行状态），四种取值各画一次；最后一条是「本客户端还没有这个 session 的
 * meta」——那种情况**不画徽标**，未知不能显示成已结束。
 */
export const WithLinkedSessions: Story = {
  args: {
    entries: [],
    sessionEvents: [
      {
        linkId: 'l1',
        sessionId: 's1',
        title: 'Fix the flaky upload retry',
        provenance: 'started from this task',
        linkedAt: 1,
        actorName: 'Codex',
        actorKind: 'agent',
        activity: 'running',
      },
      {
        linkId: 'l2',
        sessionId: 's2',
        title: 'Migrate the settings schema',
        provenance: 'linked manually',
        linkedAt: 2,
        actorName: 'Leon',
        actorKind: 'human',
        activity: 'needs-you',
      },
      {
        linkId: 'l3',
        sessionId: 's3',
        title: 'Rewrite the changelog script',
        provenance: 'started from this task',
        linkedAt: 3,
        activity: 'starting',
      },
      {
        linkId: 'l4',
        sessionId: 's4',
        title: 'Audit the image cache',
        provenance: 'proposed this task',
        linkedAt: 4,
        activity: 'idle',
      },
      {
        linkId: 'l5',
        sessionId: 's5',
        title: 'Session',
        provenance: 'spawned by an agent',
        linkedAt: 5,
        activity: null,
      },
    ],
    onSubmit: () => {},
    onOpenSession: () => {},
    onDetachSession: () => {},
  },
};
