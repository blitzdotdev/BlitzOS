export type LodyActivityKind = 'context_compaction' | 'retry';

/** Canonical identities for tool flows that Lody handles specially. */
export const LODY_TOOL_NAMES = {
  imageGeneration: 'ImageGeneration',
  cronCreate: 'CronCreate',
  cronDelete: 'CronDelete',
  cronList: 'CronList',
  scheduleWakeup: 'ScheduleWakeup',
} as const;

export type LodyActivityMeta = {
  version: 1;
  kind: LodyActivityKind;
  automatic?: boolean;
  usedTokensBefore?: number;
  usedTokensAfter?: number;
  durationMs?: number;
  failureReason?: string;
};

export type LodyTaskKind = 'subagent' | 'background' | 'scheduled';
export type LodyTaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type LodyTaskUsage = {
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
};

export type LodyTaskMeta = {
  version: 1;
  taskId: string;
  kind: LodyTaskKind;
  status: LodyTaskStatus;
  description?: string;
  actor?: string;
  parentTaskId?: string;
  parentToolCallId?: string;
  modelId?: string;
  startedAtEpochSeconds?: number;
  endedAtEpochSeconds?: number;
  summary?: string;
  error?: string;
  lastToolName?: string;
  usage?: LodyTaskUsage;
  skipTranscript?: boolean;
};

export type LodyGoalStatus = 'active' | 'paused' | 'blocked' | 'limited' | 'complete';

export type LodyGoalSnapshot = {
  objective: string;
  status: LodyGoalStatus;
  iterations?: number;
  lastReason?: string | null;
  createdAtEpochSeconds?: number;
  updatedAtEpochSeconds?: number;
  tokenBudget?: number | null;
  tokensUsed?: number;
  timeUsedSeconds?: number;
};

export type LodyGoalControlRequest =
  | { sessionId: string; action: 'set'; objective: string }
  | { sessionId: string; action: 'pause' | 'resume' | 'clear' };

export type LodyGoalControlResponse = {
  goal: LodyGoalSnapshot | null;
};

export type LodySteerPromptMeta = {
  id: string;
};

export type LodySteerRequest<TContent = unknown> = {
  sessionId: string;
  prompt: TContent[];
  steerId: string;
};

export type LodySteerResponse = {
  outcome: 'injected' | 'failed';
};

export type LodySteerApplied = {
  sessionId: string;
  steerId: string;
};

export type LodySubagentTask = {
  taskId: string;
  description: string;
  status: 'running' | 'completed' | 'failed' | 'timed_out' | 'killed' | 'lost';
  agentId?: string;
  subagentType?: string;
  modelId?: string;
  thinkingEffort?: string;
  startedAtEpochSeconds: number;
  endedAtEpochSeconds: number | null;
  stopReason?: string;
};

export type LodySubagentsListRequest = {
  sessionId: string;
  activeOnly?: boolean;
};

export type LodySubagentsListResponse = {
  tasks: LodySubagentTask[];
};

export type LodySubagentCancelRequest = {
  sessionId: string;
  taskId: string;
  reason?: string;
};

export type LodySubagentCancelResponse = Record<string, never>;

export type LodySubagentOutputRequest = {
  sessionId: string;
  taskId: string;
  tail?: number;
};

export type LodySubagentOutputResponse = {
  output: string;
};

export type LodyNotice = {
  level: 'info' | 'warning' | 'error';
  message: string;
  source?: string;
};

export type LodySessionMeta = {
  turnId?: string;
  forkAtTurn?: { version: 1; turnId?: string };
  steer?: LodySteerPromptMeta;
  toolName?: string;
  activity?: LodyActivityMeta;
  task?: LodyTaskMeta;
  goal?: LodyGoalSnapshot | null;
  notice?: LodyNotice;
  titleSource?: 'explicit' | 'generated' | 'fallback' | 'unset';
  messagePhase?: 'commentary' | 'final_answer';
};

export type LodySessionHistoryReadRequest = {
  sessionId: string;
};

export type LodySessionHistoryReadResponse = Record<string, never>;
