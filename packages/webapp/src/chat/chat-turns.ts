import type { ContentBlock, ToolResult, ToolUseBlock } from './chat-render.js';
import type { ChatPermission, ChatState, ChatTool } from './reducer.js';
import {
  asJsonObject,
  isBoolean,
  isNumber,
  isString,
  type JsonObject,
  type JsonValue,
} from '../type-guards.js';

export type ResultMeta = { success: boolean };

export type ChatItem =
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'assistant'; blocks: ContentBlock[]; inFlight: boolean }
  | { id: number; kind: 'result'; meta: ResultMeta }
  | { id: number; kind: 'system'; text: string }
  | { id: number; kind: 'error'; text: string };

export type ChatTurnStatus = 'complete' | 'failed' | 'working';

export type ChatActivitySummary = {
  commands: number;
  exploredFiles: number;
  searches: number;
  editedFiles: number;
  editOperations: number;
  subagents: number;
  otherTools: number;
  failedTools: number;
};

export type ChatTurn = {
  id: number;
  prompt: Extract<ChatItem, { kind: 'user' }>;
  items: ChatItem[];
  status: ChatTurnStatus;
  finalAssistantId?: number;
  result?: Extract<ChatItem, { kind: 'result' }>;
  activity: ChatActivitySummary;
};

export type ChatTranscriptEntry =
  | { kind: 'turn'; turn: ChatTurn }
  | { kind: 'loose'; item: ChatItem };

export type ChatTranscript = {
  entries: ChatTranscriptEntry[];
  toolResults: Record<string, ToolResult>;
  activePermission: ChatPermission | null;
};

const COMMAND_TOOLS = new Set(['bash', 'exec_command', 'shell']);
const READ_TOOLS = new Set(['read', 'readfile']);
const SEARCH_TOOLS = new Set(['glob', 'grep', 'webfetch', 'websearch']);
const EDIT_TOOLS = new Set(['edit', 'multiedit', 'notebookedit', 'write', 'apply_patch']);
const SUBAGENT_TOOLS = new Set(['task']);

const KIND_TOOL_NAMES = new Map([
  ['execute', 'Bash'],
  ['read', 'Read'],
  ['edit', 'Edit'],
  ['search', 'Grep'],
  ['fetch', 'WebFetch'],
  ['delete', 'Bash'],
  ['move', 'Bash'],
]);

/** The tool registry keys off Claude tool names; ACP gives a title and a
 * coarse kind. A single-word title is the tool name; otherwise the kind picks
 * the nearest renderer and the title survives as the row label. */
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

function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
  return block.type === 'tool_use'
    && typeof block.id === 'string'
    && typeof block.name === 'string';
}

function toolBlocks(items: ChatItem[]): ToolUseBlock[] {
  const seen = new Set<string>();
  const tools: ToolUseBlock[] = [];
  for (const item of items) {
    if (item.kind !== 'assistant') continue;
    for (const block of item.blocks) {
      if (!isToolUseBlock(block) || seen.has(block.id)) continue;
      seen.add(block.id);
      tools.push(block);
    }
  }
  return tools;
}

function filePathFrom(block: ToolUseBlock): string | undefined {
  const input = asJsonObject(block.input) ?? {};
  const value = input.file_path ?? input.path ?? input.notebook_path;
  return isString(value) && value ? value : undefined;
}

export function summarizeTurnActivity(
  items: ChatItem[],
  toolResults: Record<string, ToolResult>,
): ChatActivitySummary {
  const tools = toolBlocks(items);
  const exploredFiles = new Set<string>();
  const editedFiles = new Set<string>();
  let commands = 0;
  let searches = 0;
  let editOperations = 0;
  let subagents = 0;
  let otherTools = 0;
  let failedTools = 0;

  for (const tool of tools) {
    const name = tool.name.toLowerCase();
    const path = filePathFrom(tool);
    if (COMMAND_TOOLS.has(name)) commands += 1;
    else if (READ_TOOLS.has(name)) {
      if (path) exploredFiles.add(path);
      else otherTools += 1;
    } else if (SEARCH_TOOLS.has(name)) searches += 1;
    else if (EDIT_TOOLS.has(name)) {
      editOperations += 1;
      if (path) editedFiles.add(path);
    } else if (SUBAGENT_TOOLS.has(name)) subagents += 1;
    else otherTools += 1;

    if (toolResults[tool.id]?.isError) failedTools += 1;
  }

  return {
    commands,
    exploredFiles: exploredFiles.size,
    searches,
    editedFiles: editedFiles.size,
    editOperations,
    subagents,
    otherTools,
    failedTools,
  };
}

function hasText(blocks: ContentBlock[]): boolean {
  return blocks.some((block) => block.type === 'text'
    && isString(block.text)
    && block.text.trim().length > 0);
}

function lastItemOfKind<K extends ChatItem['kind']>(
  items: ChatItem[],
  kind: K,
): Extract<ChatItem, { kind: K }> | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === kind) {
      // SAFETY: The kind equality check just narrowed this discriminated-union member.
      return item as Extract<ChatItem, { kind: K }>;
    }
  }
  return undefined;
}

function buildTurn(
  prompt: Extract<ChatItem, { kind: 'user' }>,
  items: ChatItem[],
  toolResults: Record<string, ToolResult>,
): ChatTurn {
  const result = lastItemOfKind(items, 'result');
  const failed = items.some((item) => item.kind === 'error') || result?.meta.success === false;
  let finalAssistant: Extract<ChatItem, { kind: 'assistant' }> | undefined;
  if (!failed && result?.meta.success === true) {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item?.kind === 'assistant' && hasText(item.blocks)) {
        finalAssistant = item;
        break;
      }
    }
  }
  return {
    id: prompt.id,
    prompt,
    items,
    status: failed ? 'failed' : result ? 'complete' : 'working',
    finalAssistantId: finalAssistant?.id,
    result,
    activity: summarizeTurnActivity(items, toolResults),
  };
}

/** Renders the reducer state straight into the transcript: rows group into
 * one turn per prompt, each settled turn carries a synthetic result item, and
 * rows before the first prompt stay loose. */
export function deriveChatTranscript(state: ChatState): ChatTranscript {
  const entries: ChatTranscriptEntry[] = [];
  const toolResults: Record<string, ToolResult> = {};
  let activePermission: ChatPermission | null = null;
  let nextId = 1;
  let prompt: Extract<ChatItem, { kind: 'user' }> | null = null;
  let turnItems: ChatItem[] = [];
  let assistant: Extract<ChatItem, { kind: 'assistant' }> | null = null;

  const pushItem = (item: ChatItem): void => {
    if (prompt === null) entries.push({ kind: 'loose', item });
    else turnItems.push(item);
  };
  const openAssistant = (): Extract<ChatItem, { kind: 'assistant' }> => {
    if (assistant === null) {
      assistant = { id: nextId++, kind: 'assistant', blocks: [], inFlight: false };
      pushItem(assistant);
    }
    return assistant;
  };
  /** Every prompt span that another prompt follows settled successfully; the
   * last span settles from the run's terminal stopReason instead. */
  const closeTurn = (result: ResultMeta | null): void => {
    if (prompt === null) return;
    if (result !== null) turnItems.push({ id: nextId++, kind: 'result', meta: result });
    entries.push({ kind: 'turn', turn: buildTurn(prompt, turnItems, toolResults) });
    prompt = null;
    turnItems = [];
  };

  for (const row of state.rows) {
    if (row.kind === 'message') {
      const message = state.messages[row.id];
      if (message === undefined) continue;
      if (message.role === 'user') {
        closeTurn({ success: true });
        assistant = null;
        prompt = { id: nextId++, kind: 'user', text: message.text };
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
        pushItem({ id: nextId++, kind: 'system', text: permissionLine(permission) });
      }
    } else if (row.kind === 'plan') {
      const block = planBlock(state);
      if (block !== null) {
        const target = openAssistant();
        target.blocks = [...target.blocks, block];
      }
    } else {
      assistant = null;
      pushItem({ id: nextId++, kind: 'system', text: row.label });
    }
  }

  if (state.running) {
    // The reply being streamed is the open turn's latest assistant bubble —
    // or, before any prompt exists, the latest loose one.
    const trailing = prompt !== null
      ? turnItems
      : entries.flatMap((entry) => (entry.kind === 'loose' ? [entry.item] : []));
    const streaming = lastItemOfKind(trailing, 'assistant');
    if (streaming !== undefined) streaming.inFlight = true;
  }
  const lastStop = state.stopReasons.at(-1)?.stopReason;
  closeTurn(!state.running && lastStop !== undefined
    ? { success: lastStop !== 'refusal' }
    : null);

  return { entries, toolResults, activePermission };
}

export function activitySummaryParts(summary: ChatActivitySummary): string[] {
  const parts: string[] = [];
  if (summary.exploredFiles || summary.searches) {
    const detail = [
      summary.exploredFiles
        ? `${summary.exploredFiles} file${summary.exploredFiles === 1 ? '' : 's'}`
        : '',
      summary.searches
        ? `${summary.searches} search${summary.searches === 1 ? '' : 'es'}`
        : '',
    ].filter(Boolean).join(', ');
    parts.push(`Explored ${detail}`);
  }
  if (summary.commands) {
    parts.push(`Ran ${summary.commands} command${summary.commands === 1 ? '' : 's'}`);
  }
  if (summary.editOperations) {
    const count = summary.editedFiles || summary.editOperations;
    parts.push(`Edited ${count} file${count === 1 ? '' : 's'}`);
  }
  if (summary.subagents) {
    parts.push(`Used ${summary.subagents} subagent${summary.subagents === 1 ? '' : 's'}`);
  }
  if (summary.otherTools) {
    parts.push(`Used ${summary.otherTools} other tool${summary.otherTools === 1 ? '' : 's'}`);
  }
  if (summary.failedTools) {
    parts.push(`${summary.failedTools} failed`);
  }
  return parts;
}
