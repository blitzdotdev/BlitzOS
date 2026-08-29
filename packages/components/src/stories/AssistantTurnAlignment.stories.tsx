/**
 * Left-edge alignment guard for a streaming assistant turn.
 *
 * Every row of one turn — answer prose, the "Ran N commands" activity headers,
 * the subagent task card, and the trailing activity indicator — is a sibling in
 * the same `ConversationColumn`, so they must all start on the column's content
 * edge. A per-row horizontal pad on any one of them reads as an accidental
 * indent (the prose used to carry `sm:px-2` and sat 8px right of the chevrons).
 */
import type { Meta, StoryObj } from '@storybook/react';
import type { SessionHistoryParsed, SessionId } from '@lody/shared';
import type { ChatStreamItem, SessionChatStreamViewProps } from '@/components/ai-gui/view';
import { MessageRowView, SessionChatStreamView } from '@/components/ai-gui/view';

const meta = {
  title: 'Sessions/AssistantTurnAlignment',
  component: SessionChatStreamView,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof SessionChatStreamView>;

export default meta;
type Story = StoryObj<typeof meta>;

const sessionId = 'session-turn-alignment-storybook' as SessionId;

const renderMessageRow: SessionChatStreamViewProps['renderMessageRow'] = ({
  message,
  sessionId: storySessionId,
}) => <MessageRowView message={message} sessionId={storySessionId} />;

const streamingTurn: SessionHistoryParsed = {
  id: 'alignment-assistant',
  role: 'assistant',
  timestamp: '2026-08-11T09:00:00.000Z',
  read: true,
  finished: false,
  items: [
    { type: 'text', text: '我先查看 loro-dev/loro 仓库的 issue #1057 内容。' },
    {
      type: 'tool_call',
      toolCallId: 'alignment-tool-1',
      title: 'gh issue view 1057 --repo loro-dev/loro',
      kind: 'execute',
      status: 'completed',
      content: [
        {
          type: 'terminal_command',
          command: '/bin/bash',
          args: ['-lc', 'gh issue view 1057 --repo loro-dev/loro'],
          cwd: '/repo',
        },
      ],
    },
    {
      type: 'text',
      text: [
        '这是一个附带失败测试的 PR(#1057),报告 shallow snapshot 会保留已删除富文本 mark 的',
        'style 值(隐私泄漏)。我先看一下 PR 的测试代码和相关的编码实现。',
      ].join(' '),
    },
    {
      type: 'tool_call',
      toolCallId: 'alignment-tool-2',
      title: 'rg shallow_snapshot crates/loro-internal/src',
      kind: 'search',
      status: 'completed',
    },
    {
      type: 'tool_call',
      toolCallId: 'alignment-tool-3',
      title: 'Read crates/loro-internal/src/encoding.rs',
      kind: 'read',
      status: 'completed',
    },
    {
      type: 'subagent_task',
      taskId: 'alignment-task-1',
      status: 'in_progress',
      taskType: 'subagent',
      subagentType: 'Explore',
      description: 'Trace shallow snapshot mark encoding',
      isBackgrounded: true,
    },
  ],
};

const items: ChatStreamItem[] = [{ type: 'message', sessionId, message: streamingTurn } as const];

/**
 * Finished turn: the "Worked for …" chevron, the edited-files card, and the
 * footer action bar are the other rows keyed to the same rail.
 */
const finishedTurn: SessionHistoryParsed = {
  id: 'alignment-assistant-finished',
  role: 'assistant',
  timestamp: '2026-08-11T09:02:00.000Z',
  read: true,
  finished: true,
  endedAt: Date.parse('2026-08-11T09:02:12.000Z'),
  fileDiff: [
    { filePath: 'crates/loro-internal/src/encoding.rs', add: 24, del: 6 },
    { filePath: 'crates/loro-internal/tests/shallow_snapshot.rs', add: 61, del: 0 },
  ],
  items: [
    {
      type: 'tool_call',
      toolCallId: 'alignment-finished-tool',
      title: 'Edit crates/loro-internal/src/encoding.rs',
      kind: 'edit',
      status: 'completed',
    },
    {
      type: 'text',
      text: 'Shallow snapshot 现在会丢弃已删除 mark 的 style 值,新增的回归测试覆盖了这条路径。',
    },
  ],
};

const finishedItems: ChatStreamItem[] = [
  { type: 'message', sessionId, message: finishedTurn } as const,
];

export const DesktopStreamingTurn: Story = {
  args: { sessionId, items, renderMessageRow },
  globals: { theme: 'dark' },
  render: () => (
    <div className="h-[520px] w-full bg-background">
      <SessionChatStreamView
        items={items}
        sessionId={sessionId}
        renderMessageRow={renderMessageRow}
        agentActivityLabel="Exploring"
        agentActivityTone="warning"
      />
    </div>
  ),
};

export const DesktopFinishedTurn: Story = {
  args: { sessionId, items: finishedItems, renderMessageRow },
  globals: { theme: 'dark' },
  render: () => (
    <div className="h-[520px] w-full bg-background">
      <SessionChatStreamView
        items={finishedItems}
        sessionId={sessionId}
        renderMessageRow={renderMessageRow}
        lastAssistantMessageId={finishedTurn.id}
        lastCompletedAssistantMessageId={finishedTurn.id}
      />
    </div>
  ),
};
