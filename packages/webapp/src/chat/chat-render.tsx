import type { ToolCallContent, ToolCallStatus, ToolKind } from '@agentclientprotocol/sdk';
import {
  createContext,
  isValidElement,
  useContext,
  useState,
  type ReactNode,
} from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { previewPortFromLocalUrl } from '../preview.js';
import { isNumber, isString } from '../type-guards.js';
import {
  buildLineDiff,
  decodeHtmlEntities,
  formatUsageLimitText,
  normalizeInlineCodeFences,
  unescapeWithMathProtection,
} from './chat-format.js';
import type { ChatTool } from './reducer.js';

type OpenPreview = (port: number) => boolean;
export const PreviewLinkContext = createContext<OpenPreview | undefined>(undefined);

export function normalizeChatText(value: string): string {
  return formatUsageLimitText(unescapeWithMathProtection(
    normalizeInlineCodeFences(decodeHtmlEntities(value)),
  ));
}

function reactNodeText(node: ReactNode): string {
  if (isString(node) || isNumber(node)) return String(node);
  if (Array.isArray(node)) return node.map(reactNodeText).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return reactNodeText(node.props.children);
  return '';
}

function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  return (
    <button
      type="button"
      className="chat-copy"
      aria-label={label}
      title={label}
      onClick={() => copyText(text)}
    >
      Copy
    </button>
  );
}

export function ChatMarkdown({ children }: { children: string }) {
  const openPreview = useContext(PreviewLinkContext);
  return (
    <div className="chat-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          a({ children: anchorChildren, href, node: _node, ...props }) {
            return (
              <a
                {...props}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => {
                  const port = href ? previewPortFromLocalUrl(href) : null;
                  if (port === null || !openPreview) return;
                  if (openPreview(port)) event.preventDefault();
                }}
              >
                {anchorChildren}
              </a>
            );
          },
          pre({ children: codeChildren }) {
            const text = reactNodeText(codeChildren).replace(/\n$/u, '');
            return (
              <div className="chat-code">
                <CopyButton text={text} label="Copy code" />
                <pre>{codeChildren}</pre>
              </div>
            );
          },
        }}
      >
        {normalizeChatText(children)}
      </ReactMarkdown>
    </div>
  );
}

export function ThinkingView({ text }: { text: string }) {
  const preview = text.replace(/\s+/gu, ' ').trim().slice(0, 80);
  return (
    <details className="chat-thinking">
      <summary>
        <span>Thinking…</span>
        {preview && <span className="chat-thinking-preview">{preview}</span>}
      </summary>
      <div>{text}</div>
    </details>
  );
}

function accentForKind(kind: ToolKind | null): 'blue' | 'faint' | 'green' | 'magenta' | 'yellow' {
  switch (kind) {
    case 'read':
    case 'search':
    case 'fetch':
      return 'blue';
    case 'edit':
    case 'move':
      return 'green';
    case 'delete':
      return 'magenta';
    case 'execute':
      return 'yellow';
    default:
      return 'faint';
  }
}

function dotStatus(status: ToolCallStatus | null): 'error' | 'ok' | 'running' {
  if (status === 'completed') return 'ok';
  if (status === 'failed') return 'error';
  return 'running';
}

function DiffView({ path, oldText, newText }: { path: string; oldText: string; newText: string }) {
  return (
    <div className="chat-diff">
      <div className="chat-diff-header">
        <span className="chat-diff-path">{path}</span>
        <span className="chat-diff-badge">{oldText === '' ? 'Write' : 'Edit'}</span>
      </div>
      <div className="chat-diff-lines">
        {buildLineDiff(oldText, newText).map((line, index) => (
          <div key={`${index}:${line.type}`} className={`chat-diff-line chat-diff-line--${line.type}`}>
            <span className="chat-diff-gutter">
              {line.type === 'removed' ? '-' : line.type === 'added' ? '+' : ' '}
            </span>
            <span className="chat-diff-text">{line.text || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ToolContentItem({ content }: { content: ToolCallContent }) {
  if (content.type === 'diff') {
    return <DiffView path={content.path} oldText={content.oldText ?? ''} newText={content.newText} />;
  }
  if (content.type === 'terminal') {
    return <span className="chat-tool-secondary">Terminal {content.terminalId}</span>;
  }
  const block = content.content;
  if (block.type === 'text') return <pre className="chat-tool-output">{block.text}</pre>;
  if (block.type === 'image') {
    return <img className="chat-image" alt="Tool content" src={`data:${block.mimeType};base64,${block.data}`} />;
  }
  if (block.type === 'resource' && 'text' in block.resource) {
    return <pre className="chat-tool-output">{block.resource.text}</pre>;
  }
  return null;
}

function RawDetails({ label, value }: { label: string; value: unknown }) {
  let text: string;
  try {
    text = isString(value) ? value : JSON.stringify(value, null, 2);
  } catch {
    text = 'Unavailable';
  }
  return (
    <details className="chat-tool-raw">
      <summary>{label}</summary>
      <pre>{text}</pre>
    </details>
  );
}

// One collapsed-by-default chevron row per tool call, expanding to the full
// content, exactly like the v2 cockpit rows.
export function ToolRowView({ tool }: { tool: ChatTool }) {
  const [open, setOpen] = useState(false);
  const status = dotStatus(tool.status);
  return (
    <div className="chat-tool-call">
      <div className={`chat-tool chat-tool--${accentForKind(tool.kind)}`}>
        <button
          type="button"
          className="chat-tool-row"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <span className="chat-tool-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
          {status === 'running' ? (
            <span
              className="webapp-inline-spinner chat-tool-status chat-tool-status--running"
              role="status"
              aria-label={`${tool.title} running`}
            />
          ) : (
            <span
              className={`chat-tool-status chat-tool-status--${status}`}
              aria-label={status === 'error' ? `${tool.title} failed` : `${tool.title} completed`}
            />
          )}
          <span className="chat-tool-title">{tool.title}</span>
        </button>
        {open && (
          <div className="chat-tool-body">
            {tool.content.map((content, index) => (
              <ToolContentItem key={index} content={content} />
            ))}
            {tool.rawInput !== undefined && <RawDetails label="Raw input" value={tool.rawInput} />}
            {tool.rawOutput !== undefined && <RawDetails label="Raw output" value={tool.rawOutput} />}
          </div>
        )}
      </div>
    </div>
  );
}
