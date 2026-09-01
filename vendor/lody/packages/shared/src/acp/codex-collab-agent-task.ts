import { z } from 'zod';

import type { SubagentTaskPayload } from '../ai';

const CODEX_COLLAB_AGENT_TOOLS = [
  'spawnAgent',
  'sendInput',
  'resumeAgent',
  'wait',
  'closeAgent',
] as const;

const CodexCollabAgentStatusSchema = z.enum([
  'pendingInit',
  'running',
  'interrupted',
  'completed',
  'errored',
  'shutdown',
  'notFound',
]);

const CodexCollabAgentStateSchema = z.object({
  status: CodexCollabAgentStatusSchema,
  message: z.string().nullable(),
});

const CodexCollabAgentRawInputSchema = z.object({
  prompt: z.string().nullable(),
  senderThreadId: z.string(),
  receiverThreadIds: z.array(z.string()),
  agentsStates: z.record(z.string(), CodexCollabAgentStateSchema),
  status: z.enum(['inProgress', 'completed', 'failed']),
});

const CODEX_AGENT_STATE_TO_TASK_STATUS = {
  pendingInit: 'pending',
  running: 'in_progress',
  interrupted: 'failed',
  completed: 'completed',
  errored: 'failed',
  shutdown: 'completed',
  notFound: 'failed',
} as const satisfies Record<
  z.infer<typeof CodexCollabAgentStatusSchema>,
  SubagentTaskPayload['status']
>;

const CODEX_TOOL_STATUS_TO_TASK_STATUS = {
  inProgress: 'in_progress',
  completed: 'completed',
  failed: 'failed',
} as const satisfies Record<
  z.infer<typeof CodexCollabAgentRawInputSchema>['status'],
  SubagentTaskPayload['status']
>;

const CODEX_COLLAB_TOOL_TO_TASK_EVENT = {
  spawnAgent: 'task_started',
  sendInput: 'task_progress',
  resumeAgent: 'task_updated',
  wait: 'task_progress',
  closeAgent: 'task_updated',
} as const satisfies Record<
  (typeof CODEX_COLLAB_AGENT_TOOLS)[number],
  NonNullable<SubagentTaskPayload['event']>
>;

/**
 * Convert Codex's standard collab-agent ACP tool calls into Lody's provider-neutral task model.
 * One tool call may report several receiver threads, so this intentionally returns one task per
 * receiver. Invalid or unrelated tool calls return an empty array and stay on the generic path.
 */
export const parseCodexCollabAgentTasks = (
  title: unknown,
  rawInput: unknown
): SubagentTaskPayload[] => {
  const tool = z.enum(CODEX_COLLAB_AGENT_TOOLS).safeParse(title);
  const input = CodexCollabAgentRawInputSchema.safeParse(rawInput);
  if (!tool.success || !input.success) return [];

  const taskIds = Array.from(
    new Set([...input.data.receiverThreadIds, ...Object.keys(input.data.agentsStates)])
  ).filter(Boolean);

  return taskIds.map((taskId) => {
    const state = input.data.agentsStates[taskId];
    const message = state?.message?.trim() || undefined;
    const status = state
      ? CODEX_AGENT_STATE_TO_TASK_STATUS[state.status]
      : CODEX_TOOL_STATUS_TO_TASK_STATUS[input.data.status];
    return {
      taskId,
      status,
      event: CODEX_COLLAB_TOOL_TO_TASK_EVENT[tool.data],
      subagentType: 'Codex agent',
      taskType: tool.data,
      description: input.data.prompt?.trim() || undefined,
      summary: message,
      rawStatus: state?.status ?? input.data.status,
      error: status === 'failed' ? message : undefined,
    };
  });
};
