export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
  webSearchRequests?: number;
  costUSD?: number;
  contextWindow?: number;
};

export type SessionUsageUpdate = {
  sessionId: string;
  usage: ModelUsage;
  modelUsage?: Record<string, ModelUsage>;
};
