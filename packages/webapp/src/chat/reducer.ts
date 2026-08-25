import type {
  ContentBlock,
  PermissionOption,
  PlanEntry,
  RequestPermissionRequest,
  StopReason,
  ToolCallContent,
  ToolCallStatus,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { isString } from "../type-guards.js";

export interface ChatMessage {
  id: string;
  role: "user" | "agent" | "thought";
  text: string;
  otherContent: ContentBlock[];
  actor?: ChatActor;
}

export interface ChatActor {
  userId: string;
  name?: string;
}

export interface ChatTool {
  toolCallId: string;
  title: string;
  kind: ToolKind | null;
  status: ToolCallStatus | null;
  content: ToolCallContent[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface ChatPermission {
  toolCallId: string;
  title: string;
  options: PermissionOption[];
  answeredOptionId: string | null;
  cancelled: boolean;
  answeredBy?: ChatActor;
  rawInput?: unknown;
}

export type ChatRow =
  | { kind: "message"; id: string }
  | { kind: "tool"; id: string }
  | { kind: "plan"; id: "plan" }
  | { kind: "permission"; id: string }
  | { kind: "generic"; id: string; label: string };

interface PendingCall {
  method: "prompt" | "permission" | "other";
  targetId?: string;
}

export interface ChatState {
  rows: ChatRow[];
  messages: Record<string, ChatMessage>;
  tools: Record<string, ChatTool>;
  plan: PlanEntry[] | null;
  permissions: Record<string, ChatPermission>;
  seenText: Record<string, string[]>;
  streamText: Record<string, string>;
  pendingCalls: Record<string, PendingCall>;
  running: boolean;
  stopReasons: Array<{ turnId: string; stopReason: StopReason }>;
  sequence: number;
}

export const initialChatState: ChatState = {
  rows: [],
  messages: {},
  tools: {},
  plan: null,
  permissions: {},
  seenText: {},
  streamText: {},
  pendingCalls: {},
  running: false,
  stopReasons: [],
  sequence: 0,
};

export type ChatAction =
  | { type: "reset" }
  | { type: "update"; update: unknown; actor?: ChatActor }
  | { type: "begin-replay" }
  | { type: "reconcile-running" }
  | { type: "permission-request"; request: RequestPermissionRequest }
  | { type: "permission-answered"; toolCallId: string; optionId: string | null; actor?: ChatActor }
  | { type: "turn-started"; turnId: string }
  | { type: "turn-ended"; turnId: string; stopReason: StopReason }
  | { type: "generic"; label: string };

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "reset":
      return initialChatState;
    case "begin-replay":
      return { ...state, streamText: {} };
    case "reconcile-running": {
      if (!state.running) return state;
      const pendingCalls = Object.fromEntries(
        Object.entries(state.pendingCalls).filter(([, call]) => call.method !== "prompt"),
      );
      return { ...state, running: false, pendingCalls };
    }
    case "update":
      return applyUpdate(state, action.update, action.actor);
    case "permission-request":
      return addPermission(state, action.request);
    case "permission-answered":
      return answerPermission(state, action.toolCallId, action.optionId, action.actor);
    case "turn-started":
      return state.running
        ? state
        : {
            ...state,
            running: true,
            pendingCalls: { ...state.pendingCalls, [action.turnId]: { method: "prompt" } },
          };
    case "turn-ended":
      return finishTurn(state, action.turnId, action.stopReason);
    case "generic":
      return addGeneric(state, action.label);
  }
}

export function reduceAcpFrame(state: ChatState, frame: unknown): ChatState {
  if (!isRecord(frame) || frame.jsonrpc !== "2.0") return state;
  if (isString(frame.method)) {
    if (frame.method === "session/load") return chatReducer(state, { type: "begin-replay" });
    if (frame.method === "session/prompt" && isRequestId(frame.id)) {
      return chatReducer(state, { type: "turn-started", turnId: String(frame.id) });
    }
    if (frame.method === "session/update") {
      if (!isRecord(frame.params) || !isRecord(frame.params.update)) return state;
      const actor = parseActor(frame.params.actor);
      const action: ChatAction = { type: "update", update: frame.params.update };
      if (actor !== undefined) action.actor = actor;
      return chatReducer(state, action);
    }
    if (frame.method === "blitz/permission_answered") {
      if (!isRecord(frame.params) || !isString(frame.params.toolCallId)) return state;
      if (!(frame.params.optionId === null || isString(frame.params.optionId))) return state;
      const actor = parseActor(frame.params.actor);
      const action: ChatAction = {
        type: "permission-answered",
        toolCallId: frame.params.toolCallId,
        optionId: frame.params.optionId,
      };
      if (actor !== undefined) action.actor = actor;
      return chatReducer(state, action);
    }
    if (frame.method === "session/request_permission" && isRequestId(frame.id)) {
      const request = parsePermission(frame.params);
      if (request === null) return state;
      const next = chatReducer(state, { type: "permission-request", request });
      return {
        ...next,
        pendingCalls: {
          ...next.pendingCalls,
          [String(frame.id)]: { method: "permission", targetId: request.toolCall.toolCallId },
        },
      };
    }
    return state;
  }
  if (!isRequestId(frame.id)) return state;
  const callId = String(frame.id);
  const pending = state.pendingCalls[callId];
  if (pending === undefined || !("result" in frame) || !isRecord(frame.result)) return state;
  if (pending.method === "prompt") {
    const stopReason = parseStopReason(frame.result.stopReason);
    return stopReason === null ? state : finishTurn(state, callId, stopReason);
  }
  if (pending.method === "permission" && pending.targetId !== undefined) {
    const optionId = parsePermissionOutcome(frame.result.outcome);
    if (optionId === undefined) return state;
    const answered = answerPermission(state, pending.targetId, optionId);
    return withoutPending(answered, callId);
  }
  return withoutPending(state, callId);
}

function applyUpdate(state: ChatState, value: unknown, actor?: ChatActor): ChatState {
  if (!isRecord(value) || !isString(value.sessionUpdate)) return state;
  switch (value.sessionUpdate) {
    case "user_message_chunk":
      return addMessageChunk(state, value, "user", actor);
    case "agent_message_chunk":
      return addMessageChunk(state, value, "agent", actor);
    case "agent_thought_chunk":
      return addMessageChunk(state, value, "thought", actor);
    case "tool_call":
      return addTool(state, value);
    case "tool_call_update":
      return updateTool(state, value);
    case "plan": {
      const entries = parsePlanEntries(value.entries);
      if (entries === null) return state;
      return {
        ...state,
        plan: entries,
        rows: hasRow(state.rows, "plan", "plan")
          ? state.rows
          : [...state.rows, { kind: "plan", id: "plan" }],
      };
    }
    default:
      return addGeneric(state, `Unsupported ACP update: ${value.sessionUpdate}`);
  }
}

function addMessageChunk(
  state: ChatState,
  value: Record<string, unknown>,
  role: ChatMessage["role"],
  actor?: ChatActor,
): ChatState {
  if (!isContentBlock(value.content)) return state;
  const messageId = isString(value.messageId)
    ? value.messageId
    : `anonymous-${state.sequence + 1}`;
  const created: ChatMessage = { id: messageId, role, text: "", otherContent: [] };
  if (actor !== undefined) created.actor = actor;
  const existing = state.messages[messageId] ?? created;
  const rows = hasRow(state.rows, "message", messageId)
    ? state.rows
    : [...state.rows, { kind: "message" as const, id: messageId }];

  if (value.content.type !== "text") {
    return {
      ...state,
      rows,
      messages: {
        ...state.messages,
        [messageId]: { ...existing, otherContent: [...existing.otherContent, value.content] },
      },
      sequence: state.sequence + 1,
    };
  }

  // SAFETY: The enclosing branch has already established content.type === "text" and typeof content.text === "string".
  const text = value.content.text as string;
  const accumulated = `${state.streamText[messageId] ?? ""}${text}`;
  const seen = state.seenText[messageId] ?? [];
  const duplicate = seen.includes(accumulated);
  return {
    ...state,
    rows,
    messages: duplicate
      ? state.messages
      : { ...state.messages, [messageId]: { ...existing, text: `${existing.text}${text}` } },
    seenText: duplicate
      ? state.seenText
      : { ...state.seenText, [messageId]: [...seen, accumulated] },
    streamText: { ...state.streamText, [messageId]: accumulated },
    sequence: state.sequence + 1,
  };
}

function addTool(state: ChatState, value: Record<string, unknown>): ChatState {
  if (!isString(value.toolCallId) || !isString(value.title)) return state;
  const id = value.toolCallId;
  const content = parseToolContent(value.content);
  if (content === null) return state;
  const tool: ChatTool = {
    toolCallId: id,
    title: value.title,
    // SAFETY: Only string-ness is checked. TODO(deslop-tier-c): validate value.kind against the ToolKind literal set.
    kind: isString(value.kind) ? (value.kind as ToolKind) : null,
    // SAFETY: Only string-ness is checked. TODO(deslop-tier-c): validate value.status against the ToolCallStatus literal set.
    status: isString(value.status) ? (value.status as ToolCallStatus) : null,
    content,
  };
  if (Object.hasOwn(value, "rawInput")) tool.rawInput = value.rawInput;
  if (Object.hasOwn(value, "rawOutput")) tool.rawOutput = value.rawOutput;
  return {
    ...state,
    tools: { ...state.tools, [id]: tool },
    rows: hasRow(state.rows, "tool", id) ? state.rows : [...state.rows, { kind: "tool", id }],
  };
}

function updateTool(state: ChatState, value: Record<string, unknown>): ChatState {
  if (!isString(value.toolCallId)) return state;
  const id = value.toolCallId;
  const current = state.tools[id] ?? {
    toolCallId: id,
    title: isString(value.title) ? value.title : "Tool call",
    kind: null,
    status: null,
    content: [],
  };
  const content = parseToolContent(value.content);
  if (content === null) return state;
  const next: ChatTool = { ...current };
  if (isString(value.title)) next.title = value.title;
  if (isString(value.kind)) {
    // SAFETY: Only string-ness is checked. TODO(deslop-tier-c): validate updated value.kind against the ToolKind literal set.
    next.kind = value.kind as ToolKind;
  }
  if (isString(value.status)) {
    // SAFETY: Only string-ness is checked. TODO(deslop-tier-c): validate updated value.status against the ToolCallStatus literal set.
    next.status = value.status as ToolCallStatus;
  }
  if (value.content !== undefined) next.content = content;
  if (Object.hasOwn(value, "rawInput")) next.rawInput = value.rawInput;
  if (Object.hasOwn(value, "rawOutput")) next.rawOutput = value.rawOutput;
  return {
    ...state,
    tools: { ...state.tools, [id]: next },
    rows: hasRow(state.rows, "tool", id) ? state.rows : [...state.rows, { kind: "tool", id }],
  };
}

function addPermission(state: ChatState, request: RequestPermissionRequest): ChatState {
  const id = request.toolCall.toolCallId;
  const existing = state.permissions[id];
  const permission: ChatPermission = {
    toolCallId: id,
    title: request.toolCall.title ?? state.tools[id]?.title ?? "Permission required",
    options: request.options,
    answeredOptionId: existing?.answeredOptionId ?? null,
    cancelled: existing?.cancelled ?? false,
  };
  if (request.toolCall.rawInput !== undefined) permission.rawInput = request.toolCall.rawInput;
  return {
    ...state,
    permissions: { ...state.permissions, [id]: permission },
    rows: hasRow(state.rows, "permission", id)
      ? state.rows
      : [...state.rows, { kind: "permission", id }],
  };
}

function answerPermission(state: ChatState, id: string, optionId: string | null, actor?: ChatActor): ChatState {
  const permission = state.permissions[id];
  if (permission === undefined || permission.answeredOptionId !== null || permission.cancelled) return state;
  const answered: ChatPermission = {
    ...permission,
    answeredOptionId: optionId,
    cancelled: optionId === null,
  };
  if (actor !== undefined) answered.answeredBy = actor;
  return {
    ...state,
    permissions: {
      ...state.permissions,
      [id]: answered,
    },
  };
}

function parseActor<Value>(value: Value): ChatActor | undefined {
  if (!isRecord(value) || !isString(value.userId)) return undefined;
  if (!(value.name === undefined || isString(value.name))) return undefined;
  const actor: ChatActor = { userId: value.userId };
  if (isString(value.name)) actor.name = value.name;
  return actor;
}

function finishTurn(state: ChatState, turnId: string, stopReason: StopReason): ChatState {
  if (!state.running || state.stopReasons.some((turn) => turn.turnId === turnId)) return state;
  return withoutPending(
    { ...state, running: false, stopReasons: [...state.stopReasons, { turnId, stopReason }] },
    turnId,
  );
}

function addGeneric(state: ChatState, label: string): ChatState {
  const sequence = state.sequence + 1;
  return {
    ...state,
    rows: [...state.rows, { kind: "generic", id: `generic-${sequence}`, label }],
    sequence,
  };
}

function withoutPending(state: ChatState, id: string): ChatState {
  const pendingCalls = { ...state.pendingCalls };
  delete pendingCalls[id];
  return { ...state, pendingCalls };
}

function parsePermission(value: unknown): RequestPermissionRequest | null {
  if (!isRecord(value) || !isString(value.sessionId) || !isRecord(value.toolCall)) return null;
  if (!isString(value.toolCall.toolCallId) || !Array.isArray(value.options)) return null;
  const options = value.options.filter((option): option is PermissionOption =>
    isRecord(option) &&
    isString(option.optionId) &&
    isString(option.name) &&
    isString(option.kind)
  );
  if (options.length !== value.options.length) return null;
  // SAFETY: Top-level identifiers and option strings are checked, but the nested ACP tool-call shape and option kind values are not. TODO(deslop-tier-c): validate the complete RequestPermissionRequest union before returning it.
  return value as typeof value & RequestPermissionRequest;
}

function parsePlanEntries(value: unknown): PlanEntry[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((entry) =>
    isRecord(entry) &&
    isString(entry.content) &&
    (entry.priority === "high" || entry.priority === "medium" || entry.priority === "low") &&
    (entry.status === "pending" || entry.status === "in_progress" || entry.status === "completed")
  )) return null;
  // SAFETY: Every entry's content, priority, and status fields were checked against the PlanEntry contract.
  return value as PlanEntry[];
}

function parseToolContent(value: unknown): ToolCallContent[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  if (!value.every((item) => {
    if (!isRecord(item) || !isString(item.type)) return false;
    if (item.type === "content") return isContentBlock(item.content);
    if (item.type === "terminal") return isString(item.terminalId);
    return item.type === "diff" &&
      isString(item.path) &&
      isString(item.newText) &&
      (item.oldText === undefined || item.oldText === null || isString(item.oldText));
  })) return null;
  // SAFETY: Every item was checked against the supported content, terminal, or diff field contract.
  return value as ToolCallContent[];
}

function isContentBlock(value: unknown): value is ContentBlock {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "text") return typeof value.text === "string";
  if (value.type === "image" || value.type === "audio") {
    return typeof value.data === "string" && typeof value.mimeType === "string";
  }
  if (value.type === "resource_link") return typeof value.name === "string" && typeof value.uri === "string";
  if (value.type !== "resource" || !isRecord(value.resource) || typeof value.resource.uri !== "string") return false;
  return typeof value.resource.text === "string" || typeof value.resource.blob === "string";
}

function parsePermissionOutcome(value: unknown): string | null | undefined {
  if (!isRecord(value) || !isString(value.outcome)) return undefined;
  if (value.outcome === "cancelled") return null;
  if (value.outcome === "selected" && isString(value.optionId)) return value.optionId;
  return undefined;
}

function parseStopReason(value: unknown): StopReason | null {
  return value === "end_turn" ||
    value === "max_tokens" ||
    value === "max_turn_requests" ||
    value === "refusal" ||
    value === "cancelled"
    ? value
    : null;
}

function hasRow(rows: readonly ChatRow[], kind: ChatRow["kind"], id: string): boolean {
  return rows.some((row) => row.kind === kind && row.id === id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}
