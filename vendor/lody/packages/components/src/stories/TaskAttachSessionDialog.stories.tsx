import type { Meta, StoryObj } from '@storybook/react';
import { TaskAttachSessionDialog } from '@/components/tasks/task-attach-session-dialog';

/**
 * 把已有对话记到任务下（`manual-attach` 来源）。已经属于别的任务的对话会**列出
 * 但禁用并给出原因**，而不是过滤掉——消失的选项无法回答「我那个对话怎么不在」。
 */
const meta = {
  title: 'Tasks/TaskAttachSessionDialog',
  component: TaskAttachSessionDialog,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof TaskAttachSessionDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

const sessions = [
  {
    sessionId: 's1',
    title: 'Migrate the settings dialog',
    contextLabel: 'loro-dev/lody',
    lastMessageAt: 99,
  },
  {
    sessionId: 's2',
    title: 'Poke at the PR poller',
    contextLabel: 'loro-dev/lody',
    lastMessageAt: 50,
  },
  {
    sessionId: 's3',
    title: 'Already recorded elsewhere',
    lastMessageAt: 40,
    attachedTaskTitle: 'Refactor the auth flow',
  },
  { sessionId: 's4', title: '', lastMessageAt: 1 },
];

export const Default: Story = {
  args: { open: true, sessions, onAttach: () => {}, onClose: () => {} },
};

/** 没有可关联的对话时给一句话，而不是空白面板。 */
export const Empty: Story = {
  args: { open: true, sessions: [], onAttach: () => {}, onClose: () => {} },
};

/** 全部被别的任务占用：仍然可见，仍然说明原因。 */
export const AllTaken: Story = {
  args: {
    open: true,
    sessions: sessions.map((entry) => ({
      ...entry,
      attachedTaskTitle: entry.attachedTaskTitle ?? 'Another task',
    })),
    onAttach: () => {},
    onClose: () => {},
  },
};
