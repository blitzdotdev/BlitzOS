export type PermissionMode = "allow" | "deny" | "ask";

export interface PermissionOption {
  optionId: string;
  name: string;
  description?: string;
  kind?: "allow_once" | "allow_always" | "allow" | "deny" | "reject_once";
}

export interface PermissionRequest {
  requestId: string;
  options: readonly PermissionOption[];
  outcome?: PermissionOutcome;
}

export interface PermissionHistoryItem {
  type: string;
  toolCallId?: string;
  title?: string | null;
  toolName?: string;
  kind?: string;
  rawInput?: { command?: string };
  permissionRequest?: PermissionRequest;
}

export interface PermissionHistoryEntry {
  items?: readonly PermissionHistoryItem[];
}

export interface PermissionOutcome {
  outcome: "selected";
  optionId: string;
}

export interface PermissionResponseMessage {
  type: "session/permission_response";
  sessionId: string;
  requestId: string;
  outcome: PermissionOutcome;
}

export interface PendingPermissionRequest {
  requestId: string;
  options: readonly PermissionOption[];
  toolSummary: string;
}

export function parsePermissionMode(value: string | undefined, flag?: string): PermissionMode;
export function pendingPermissionRequests(
  history: readonly PermissionHistoryEntry[],
): PendingPermissionRequest[];
export function answerSessionPermissions(input: {
  sessionId: string;
  permissions: PermissionMode;
  history: readonly PermissionHistoryEntry[];
  answeredRequestIds: Set<string>;
  respond: (response: PermissionResponseMessage) => Promise<void>;
  log: (line: string) => void;
}): Promise<PermissionResponseMessage[]>;
