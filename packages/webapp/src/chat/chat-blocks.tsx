import type { ReactNode } from 'react';
import {
  ChatMarkdown,
  PreviewLinkContext,
  WorkspaceFileLinkContext,
  ToolCallView,
  stringValue,
  type ContentBlock,
  type OpenPreview,
  type TextBlock,
  type ThinkingBlock,
  type ToolResult,
  type ToolUseBlock,
} from './chat-render.js';

function ThinkingView({ block }: { block: ThinkingBlock }) {
  const thinking = stringValue(block.thinking);
  const preview = thinking.replace(/\s+/gu, ' ').trim().slice(0, 80);
  return (
    <details className="chat-thinking">
      <summary>
        <span>Thinking…</span>
        {preview && <span className="chat-thinking-preview">{preview}</span>}
      </summary>
      <div>{thinking}</div>
    </details>
  );
}

function isToolUse(block: ContentBlock): block is ToolUseBlock {
  return block.type === 'tool_use'
    && typeof block.id === 'string'
    && typeof block.name === 'string';
}

function isThinking(block: ContentBlock): block is ThinkingBlock {
  return block.type === 'thinking' && typeof block.thinking === 'string';
}

function isText(block: ContentBlock): block is TextBlock {
  return block.type === 'text' && typeof block.text === 'string';
}

export function AssistantBlocks({
  blocks,
  toolResults,
  showThinking,
  inFlight = false,
  onOpenPreview,
  onOpenFile,
  workingDirectory = '/home/dev',
}: {
  blocks: ContentBlock[];
  toolResults: Record<string, ToolResult>;
  showThinking: boolean;
  inFlight?: boolean;
  onOpenPreview?: OpenPreview;
  onOpenFile?: (filePath: string) => void;
  workingDirectory?: string;
}) {
  const nodes: ReactNode[] = [];
  let lastTextIndex = -1;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (isText(blocks[index]!)) {
      lastTextIndex = index;
      break;
    }
  }

  for (let index = 0; index < blocks.length;) {
    const block = blocks[index]!;
    if (isToolUse(block)) {
      const calls = [block];
      const deferredThinking: ThinkingBlock[] = [];
      let next = index + 1;
      while (next < blocks.length) {
        const candidate = blocks[next]!;
        if (isThinking(candidate)) {
          if (candidate.thinking.trim()) deferredThinking.push(candidate);
          next += 1;
          continue;
        }
        if (isToolUse(candidate) && candidate.name === block.name) {
          calls.push(candidate);
          next += 1;
          continue;
        }
        break;
      }

      if (calls.length >= 2) {
        nodes.push(
          <details key={`group:${block.id}`} className="chat-tool-group">
            <summary>{block.name} ×{calls.length}</summary>
            <div className="chat-tool-group-body">
              {calls.map((call) => (
                <ToolCallView key={call.id} call={call} result={toolResults[call.id]} />
              ))}
            </div>
          </details>,
        );
        if (showThinking) {
          deferredThinking.forEach((thinking, thinkingIndex) => {
            nodes.push(<ThinkingView key={`thinking:${index}:${thinkingIndex}`} block={thinking} />);
          });
        }
        index = next;
        continue;
      }

      nodes.push(<ToolCallView key={block.id} call={block} result={toolResults[block.id]} />);
      index += 1;
      continue;
    }

    if (isText(block)) {
      nodes.push(
        <div key={`text:${index}`} className="chat-assistant-text">
          <ChatMarkdown>{block.text}</ChatMarkdown>
          {inFlight && index === lastTextIndex && <span className="chat-stream-cursor">▍</span>}
        </div>,
      );
    } else if (showThinking && isThinking(block) && block.thinking.trim()) {
      nodes.push(<ThinkingView key={`thinking:${index}`} block={block} />);
    } else if (!isThinking(block)) {
      nodes.push(
        <details key={`unknown:${index}`} className="chat-unknown-block">
          <summary>Unrecognized content: {block.type || 'unknown'}</summary>
          <pre>{JSON.stringify(block, null, 2)}</pre>
        </details>,
      );
    }
    index += 1;
  }

  return (
    <PreviewLinkContext.Provider value={onOpenPreview}>
      <WorkspaceFileLinkContext.Provider value={onOpenFile
        ? { onOpenFile, workingDirectory }
        : undefined}
      >
        {nodes}
      </WorkspaceFileLinkContext.Provider>
    </PreviewLinkContext.Provider>
  );
}
