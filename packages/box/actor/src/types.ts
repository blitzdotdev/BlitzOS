import type {
  ContentBlock,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
  StopReason,
} from "@agentclientprotocol/sdk";
import type { AgentConfig } from "./agent-config.js";

export type Provider = "claude" | "codex";

export type TurnInput = {
  sessionId: string;
  turnId: string;
  cwd: string;
  prompt: ContentBlock[];
  resumeId: string | null;
  signal: AbortSignal;
  token: string | null;
  config: AgentConfig;
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
