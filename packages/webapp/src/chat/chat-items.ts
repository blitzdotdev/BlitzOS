import type { ContentBlock, ToolResult } from './chat-render.js';
import type { ChatPermission, ChatState, ChatTool } from './reducer.js';
import {
  asJsonObject,
  isBoolean,
  isNumber,
  isString,
  type JsonObject,
  type JsonValue,
} from '../type-guards.js';

/** The donor transcript model (monorepov2 ChatPanel): flat items plus a
 * tool-result index, grouped into turns by chat-turns. This adapter derives
 * that model from the ACP reducer state so the donor UI renders unchanged. */

export type ResultMeta = { success: boolean };

export type ChatItem =
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'assistant'; blocks: ContentBlock[]; inFlight: boolean }
  | { id: number; kind: 'result'; meta: ResultMeta }
  | { id: number; kind: 'system'; text: string }
  | { id: number; kind: 'error'; text: string };

export type DerivedChat = {
  items: ChatItem[];
  toolResults: Record<string, ToolResult>;
  activePermission: ChatPermission | null;
};

const KIND_TOOL_NAMES = new Map([
  ['execute', 'Bash'],
  ['read', 'Read'],
  ['edit', 'Edit'],
  ['search', 'Grep'],
  ['fetch', 'WebFetch'],
  ['delete', 'Bash'],
  ['move', 'Bash'],
]);

/** The donor tool registry keys off Claude tool names; ACP gives a title and
 * a coarse kind. A single-word title is the tool name; otherwise the kind
 * picks the nearest renderer and the title survives as the row label. */
function toolName(tool: ChatTool): string {
  if (/^[A-Za-z_]+$/u.test(tool.title)) return tool.title;
  return (tool.kind !== null ? KIND_TOOL_NAMES.get(tool.kind) : undefined) ?? tool.title;
}

/** ACP raw payloads travel as JSON; anything non-JSON is dropped rather
 * than rendered wrong. */
function asJsonValue<Value>(value: Value): JsonValue | null {
  if (value === null) return null;
  if (isString(value) || isNumber(value) || isBoolean(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => asJsonValue(entry) ?? null);
  }
  const source = asJsonObject(value);
  if (source !== null) {
    const record: JsonObject = {};
    for (const [key, entry] of Object.entries(source)) {
      const parsed = asJsonValue(entry);
      if (parsed !== null) record[key] = parsed;
    }
    return record;
  }
  return null;
}

function toolInput(tool: ChatTool): JsonValue | null {
  if (tool.rawInput !== undefined && tool.rawInput !== null) {
    return asJsonValue(tool.rawInput);
  }
  const diff = tool.content.find((entry) => entry.type === 'diff');
  if (diff !== undefined && diff.type === 'diff') {
    return {
      file_path: diff.path,
      old_string: diff.oldText ?? '',
      new_string: diff.newText,
    };
  }
  return {};
}

function toolResultOf(tool: ChatTool): ToolResult {
  const texts = tool.content.flatMap((entry) => (
    entry.type === 'content' && entry.content.type === 'text' ? [entry.content.text] : []
  ));
  const result: ToolResult = {
    content: texts.join('\n'),
    isError: tool.status === 'failed',
  };
  const rawOutput = tool.rawOutput === undefined ? null : asJsonValue(tool.rawOutput);
  if (rawOutput !== null) result.toolUseResult = rawOutput;
  return result;
}

function permissionLine(permission: ChatPermission): string {
  if (permission.cancelled) return `Dismissed — ${permission.title}`;
  const option = permission.options.find(
    ({ optionId }) => optionId === permission.answeredOptionId,
  );
  const by = permission.answeredBy?.name !== undefined
    ? ` · by ${permission.answeredBy.name}`
    : '';
  return `${option?.name ?? 'Answered'} — ${permission.title}${by}`;
}

function planBlock(state: ChatState): ContentBlock | null {
  if (state.plan === null || state.plan.length === 0) return null;
  return {
    type: 'tool_use',
    id: 'acp-plan',
    name: 'TodoWrite',
    input: {
      todos: state.plan.map((entry) => ({
        content: entry.content,
        status: entry.status,
      })),
    },
  };
}

export function deriveChatItems(state: ChatState): DerivedChat {
  const items: ChatItem[] = [];
  const toolResults: Record<string, ToolResult> = {};
  let activePermission: ChatPermission | null = null;
  let nextId = 1;
  let assistant: Extract<ChatItem, { kind: 'assistant' }> | null = null;

  const openAssistant = (): Extract<ChatItem, { kind: 'assistant' }> => {
    if (assistant === null) {
      assistant = { id: nextId++, kind: 'assistant', blocks: [], inFlight: false };
      items.push(assistant);
    }
    return assistant;
  };

  for (const row of state.rows) {
    if (row.kind === 'message') {
      const message = state.messages[row.id];
      if (message === undefined) continue;
      if (message.role === 'user') {
        assistant = null;
        items.push({ id: nextId++, kind: 'user', text: message.text });
      } else if (message.text.length > 0) {
        const target = openAssistant();
        target.blocks = [...target.blocks, message.role === 'thought'
          ? { type: 'thinking', thinking: message.text }
          : { type: 'text', text: message.text }];
      }
    } else if (row.kind === 'tool') {
      const tool = state.tools[row.id];
      if (tool === undefined) continue;
      const target = openAssistant();
      target.blocks = [...target.blocks, {
        type: 'tool_use',
        id: tool.toolCallId,
        name: toolName(tool),
        input: toolInput(tool),
      }];
      toolResults[tool.toolCallId] = toolResultOf(tool);
    } else if (row.kind === 'permission') {
      const permission = state.permissions[row.id];
      if (permission === undefined) continue;
      if (permission.answeredOptionId === null && !permission.cancelled) {
        activePermission = permission;
      } else {
        assistant = null;
        items.push({ id: nextId++, kind: 'system', text: permissionLine(permission) });
      }
    } else if (row.kind === 'plan') {
      const block = planBlock(state);
      if (block !== null) {
        const target = openAssistant();
        target.blocks = [...target.blocks, block];
      }
    } else {
      assistant = null;
      items.push({ id: nextId++, kind: 'system', text: row.label });
    }
  }

  // Turn results: every prompt span that another prompt follows is settled;
  // the last span settles when the run stops (refusal reads as failure).
  const lastStop = state.stopReasons.at(-1)?.stopReason;
  const withResults: ChatItem[] = [];
  const spanEnds: number[] = [];
  for (let index = 0; index < items.length; index += 1) {
    if (items[index]?.kind === 'user' && index > 0) spanEnds.push(index);
  }
  let spanCursor = 0;
  for (let index = 0; index < items.length; index += 1) {
    if (spanEnds[spanCursor] === index) {
      spanCursor += 1;
      withResults.push({ id: nextId++, kind: 'result', meta: { success: true } });
    }
    // SAFETY: index iterates [0, items.length); the slot is always present.
    withResults.push(items[index] as ChatItem);
  }
  const lastItem = withResults.at(-1);
  const hasOpenPrompt = withResults.some((item) => item.kind === 'user')
    && lastItem?.kind !== 'result';
  if (hasOpenPrompt && !state.running && lastStop !== undefined) {
    withResults.push({
      id: nextId++,
      kind: 'result',
      meta: { success: lastStop !== 'refusal' },
    });
  }

  if (state.running) {
    for (let index = withResults.length - 1; index >= 0; index -= 1) {
      const item = withResults[index];
      if (item?.kind === 'assistant') {
        withResults[index] = { ...item, inFlight: true };
        break;
      }
      if (item?.kind === 'user') break;
    }
  }

  return { items: withResults, toolResults, activePermission };
}
