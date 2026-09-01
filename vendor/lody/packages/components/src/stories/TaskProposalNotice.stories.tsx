import type { Meta, StoryObj } from '@storybook/react';
import type { SessionId } from '@lody/shared';
import { TooltipProvider } from '@/ui/tooltip';
import { TaskProposalNotice } from '@/components/tasks/task-proposal-notice';

/**
 * Agent 在会话里提议「把这件事记成任务」的卡片。
 *
 * 它是 session history 里的一条 `system_notice`，不是弹窗——没人看着的时候提出的
 * 提案，几天后回来仍然在、仍然可确认。确认才创建任务，忽略则什么都不发生。
 */
const meta = {
  title: 'Tasks/TaskProposalNotice',
  component: TaskProposalNotice,
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
} satisfies Meta<typeof TaskProposalNotice>;

export default meta;
type Story = StoryObj<typeof meta>;

const base = {
  sessionId: 'session-1' as SessionId,
  entryId: 'entry-1',
  itemIndex: 0,
};

/** 待确认：这是提案卡的主状态，可以搁置任意久。 */
export const Pending: Story = {
  args: {
    ...base,
    meta: {
      proposalId: 'p1',
      title: 'Drop the deprecated WS control plane',
      body: 'Audit remaining callers, migrate the retry path, delete the listener.',
      proposedBy: { kind: 'agent', agentConfigId: 'a1', name: 'Codex' },
    },
  },
};

/** 没有正文：只有标题也应该能确认。 */
export const TitleOnly: Story = {
  args: {
    ...base,
    meta: {
      proposalId: 'p2',
      title: 'Rewrite the onboarding copy',
      proposedBy: { kind: 'agent', agentConfigId: 'a1', name: 'Codex' },
    },
  },
};

/** 已确认：卡片留在历史里，指向创建出来的任务。 */
export const Created: Story = {
  args: {
    ...base,
    meta: {
      proposalId: 'p3',
      title: 'Drop the deprecated WS control plane',
      body: 'Audit remaining callers.',
      outcome: 'created',
      taskId: 'task-1',
      proposedBy: { kind: 'agent', agentConfigId: 'a1', name: 'Codex' },
    },
  },
};

/** 已忽略：不再邀请操作，但记录仍在。 */
export const Dismissed: Story = {
  args: {
    ...base,
    meta: {
      proposalId: 'p4',
      title: 'Drop the deprecated WS control plane',
      outcome: 'dismissed',
      proposedBy: { kind: 'agent', agentConfigId: 'a1', name: 'Codex' },
    },
  },
};

/** 无署名：旧历史条目可能没有 proposedBy，不能因此崩。 */
export const WithoutAttribution: Story = {
  args: {
    ...base,
    meta: {
      proposalId: 'p5',
      title: 'Drop the deprecated WS control plane',
    },
  },
};
