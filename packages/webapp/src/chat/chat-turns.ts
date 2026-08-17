import type { ChatItem } from './chat-items.js';
import type { ContentBlock, ToolResult, ToolUseBlock } from './chat-render.js';
import { asJsonObject, isString } from '../type-guards.js';

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

const COMMAND_TOOLS = new Set(['bash', 'exec_command', 'shell']);
const READ_TOOLS = new Set(['read', 'readfile']);
const SEARCH_TOOLS = new Set(['glob', 'grep', 'webfetch', 'websearch']);
const EDIT_TOOLS = new Set(['edit', 'multiedit', 'notebookedit', 'write', 'apply_patch']);
const SUBAGENT_TOOLS = new Set(['task']);

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

export function deriveChatTranscript(
  items: ChatItem[],
  toolResults: Record<string, ToolResult>,
): ChatTranscriptEntry[] {
  const entries: ChatTranscriptEntry[] = [];
  let prompt: Extract<ChatItem, { kind: 'user' }> | undefined;
  let turnItems: ChatItem[] = [];

  const finishTurn = () => {
    if (!prompt) return;
    entries.push({ kind: 'turn', turn: buildTurn(prompt, turnItems, toolResults) });
    prompt = undefined;
    turnItems = [];
  };

  for (const item of items) {
    if (item.kind === 'user') {
      finishTurn();
      prompt = item;
      continue;
    }
    if (!prompt) {
      entries.push({ kind: 'loose', item });
      continue;
    }
    turnItems.push(item);
    if (item.kind === 'result') finishTurn();
  }
  finishTurn();
  return entries;
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
