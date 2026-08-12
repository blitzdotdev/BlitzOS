import type {
  ContentBlock,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
  StopReason,
} from "@agentclientprotocol/sdk";

export type Provider = "claude" | "codex";

export type TurnInput = {
  sessionId: string;
  turnId: string;
  cwd: string;
  prompt: ContentBlock[];
  resumeId: string | null;
  signal: AbortSignal;
  token: string | null;
  emit(update: SessionUpdate): Promise<void>;
  requestPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse>;
};

export type TurnOutput = {
  stopReason: StopReason;
  resumeId?: string;
};

export interface AgentAdapter {
  runTurn(input: TurnInput): Promise<TurnOutput>;
}

export type AdapterFactory = (provider: Provider) => AgentAdapter;
