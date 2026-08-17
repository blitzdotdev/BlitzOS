import {
  createContext,
  type ReactNode,
  isValidElement,
  useContext,
  useState,
} from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { CodeView } from './chat-code.js';
import {
  basename,
  buildLineDiff,
  decodeHtmlEntities,
  formatUsageLimitText,
  normalizeInlineCodeFences,
  unescapeWithMathProtection,
} from './chat-format.js';
import { previewPortFromLocalUrl } from '../preview.js';
import {
  asJsonObject,
  isNumber,
  isString,
  type JsonObject,
  type JsonValue,
} from '../type-guards.js';

export type OpenPreview = (port: number) => boolean;
export const PreviewLinkContext = createContext<OpenPreview | undefined>(undefined);
type WorkspaceFileLinks = {
  workingDirectory: string;
  onOpenFile: (filePath: string) => void;
};
export const WorkspaceFileLinkContext = createContext<WorkspaceFileLinks | undefined>(undefined);

export type TextBlock = { type: 'text'; text: string };
export type ThinkingBlock = { type: 'thinking'; thinking: string };
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: JsonValue | null };
export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ({ type: string } & JsonObject);

export type ToolResult = {
  content: JsonValue;
  isError: boolean;
  toolUseResult?: JsonValue;
};

type ToolAccent = 'blue' | 'faint' | 'green' | 'magenta' | 'yellow';

// Every tool call renders as one collapsed-by-default chevron row (donor's
// inlineDetails pattern): a one-line summary with live status, expanding to
// the full input detail and full result. Nothing is hidden, only collapsed.
export type ToolRendererConfig = {
  accent: ToolAccent;
  label?: string;
  getValue?: (input: JsonObject) => string;
  // Full text revealed in the expanded view when the row value is abbreviated
  // (e.g. Read shows the basename collapsed, the full path expanded).
  getDetail?: (input: JsonObject) => string;
  getSecondary?: (input: JsonObject) => string;
  terminalStyle?: boolean;
  title?: (input: JsonObject) => string;
  defaultOpen?: boolean;
  plan?: boolean;
  content?: (input: JsonObject) => ReactNode;
  // Collapsed-row hint shown once the result arrives (e.g. exit code + first
  // output line for Bash, "Found N files" for Grep).
  resultHint?: (result: ToolResult) => string;
  resultContent?: (result: ToolResult, input: JsonObject) => ReactNode;
};

function asRecord<Value>(value: Value): JsonObject {
  return asJsonObject(value) ?? {};
}

export function stringValue(value: JsonValue | undefined): string {
  return isString(value) ? value : '';
}

export function textFromContent<Value>(value: Value): string {
  if (isString(value)) {
    try {
      const decoded: unknown = JSON.parse(value);
      if (Array.isArray(decoded)) return textFromContent(decoded);
    } catch {
      return value;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (isString(entry)) return entry;
      const block = asRecord(entry);
      return block.type === 'text' ? stringValue(block.text) : '';
    }).filter(Boolean).join('\n');
  }
  const record = asJsonObject(value);
  if (record !== null && isString(record.text)) return record.text;
  return value == null ? '' : JSON.stringify(value, null, 2);
}

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

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="chat-copy"
      aria-label={label}
      title={label}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1_200);
        }).catch(() => undefined);
      }}
    >
      {copied ? (
        <span aria-hidden="true">✓</span>
      ) : (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <rect x="5" y="5" width="8" height="8" rx="1" />
          <path d="M3 10H2V2h8v1" />
        </svg>
      )}
    </button>
  );
}

export function workspaceFilePath(href: string, workingDirectory: string): string | null {
  if (/^(?:https?:|mailto:|tel:|#)/iu.test(href)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(href.split(/[?#]/u, 1)[0] ?? '');
  } catch {
    return null;
  }
  if (decoded.startsWith('file://')) decoded = decoded.slice('file://'.length);
  if (decoded.startsWith('/')) {
    const root = workingDirectory.replace(/\/$/u, '');
    if (decoded !== root && !decoded.startsWith(`${root}/`)) return null;
    decoded = decoded.slice(root.length).replace(/^\//u, '');
  }
  if (!decoded || decoded.split('/').includes('..')) return null;
  return decoded.replace(/^\.\//u, '');
}

export function ChatMarkdown({ children }: { children: string }) {
  const openPreview = useContext(PreviewLinkContext);
  const workspaceFiles = useContext(WorkspaceFileLinkContext);
  return (
    <div className="chat-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          a({ children: anchorChildren, href, node: _node, ...props }) {
            const filePath = href && workspaceFiles
              ? workspaceFilePath(href, workspaceFiles.workingDirectory)
              : null;
            return (
              <a
                {...props}
                href={href}
                target={filePath ? undefined : '_blank'}
                rel={filePath ? undefined : 'noopener noreferrer'}
                onClick={(event) => {
                  const port = href ? previewPortFromLocalUrl(href) : null;
                  if (port !== null && openPreview?.(port)) {
                    event.preventDefault();
                    return;
                  }
                  if (filePath && workspaceFiles) {
                    event.preventDefault();
                    workspaceFiles.onOpenFile(filePath);
                  }
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

function RawInput({ input }: { input: JsonValue | null }) {
  return (
    <details className="chat-tool-raw">
      <summary>Raw</summary>
      <CodeView text={JSON.stringify(input, null, 2)} language="json" />
    </details>
  );
}

function DiffContent({
  input,
  badge,
}: {
  input: JsonObject;
  badge: 'Edit' | 'Patch';
}) {
  const path = stringValue(input.file_path);
  return (
    <div className="chat-diff">
      <div className="chat-diff-header">
        <span className="chat-diff-path">{path}</span>
        <span className="chat-diff-badge">{badge}</span>
      </div>
      <div className="chat-diff-lines">
        {buildLineDiff(stringValue(input.old_string), stringValue(input.new_string))
          .map((line, index) => (
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

// Write payloads render as a highlighted code view of the new file content.
function WriteContent({ input }: { input: JsonObject }) {
  const path = stringValue(input.file_path);
  return (
    <div className="chat-diff">
      <div className="chat-diff-header">
        <span className="chat-diff-path">{path}</span>
        <span className="chat-diff-badge chat-diff-badge--new">New</span>
      </div>
      <CodeView text={stringValue(input.content)} filename={basename(path)} />
    </div>
  );
}

function TodoContent({ input }: { input: JsonObject }) {
  const todos = Array.isArray(input.todos) ? input.todos : [];
  return (
    <ul className="chat-todos">
      {todos.map((todo, index) => {
        const item = asRecord(todo);
        const status = stringValue(item.status) || 'pending';
        const glyph = status === 'completed' ? '●' : status === 'in_progress' ? '◐' : '○';
        return (
          <li key={`${index}:${stringValue(item.content)}`} className={`chat-todo chat-todo--${status}`}>
            <span aria-hidden="true">{glyph}</span>
            <span>{stringValue(item.content)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function TaskContent({ input }: { input: JsonObject }) {
  const lines: string[] = [];
  if (input.model != null) lines.push(`**Model:** ${String(input.model)}`);
  lines.push(`**Prompt:**\n${stringValue(input.prompt)}`);
  if (input.resume != null) lines.push(`**Resuming from:** ${String(input.resume)}`);
  return <ChatMarkdown>{lines.join('\n\n')}</ChatMarkdown>;
}

function QuestionsContent({ input }: { input: JsonObject }) {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const answers = asRecord(input.answers);
  return (
    <div className="chat-questions">
      {questions.map((question, questionIndex) => {
        const item = asRecord(question);
        const questionText = stringValue(item.question);
        const answer = String(
          answers[questionText]
          ?? answers[stringValue(item.header)]
          ?? answers[String(questionIndex)]
          ?? '',
        );
        const options = Array.isArray(item.options) ? item.options : [];
        return (
          <div key={`${questionIndex}:${questionText}`} className="chat-question">
            <div className="chat-question-text">{questionText}</div>
            <ul>
              {options.map((option, optionIndex) => {
                const optionRecord = asRecord(option);
                const label = stringValue(optionRecord.label) || String(option);
                const selected = answer === label || answer.includes(label);
                return (
                  <li
                    key={`${optionIndex}:${label}`}
                    className={selected ? 'chat-question-option--selected' : undefined}
                  >
                    <span aria-hidden="true">{selected ? '●' : '○'}</span>
                    <span>
                      {label}
                      {optionRecord.description ? ` — ${String(optionRecord.description)}` : ''}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function questionTitle(input: JsonObject): string {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  let title = `${questions.length} questions`;
  if (questions.length === 1) title = stringValue(asRecord(questions[0]).header) || 'Question';
  if (Object.keys(asRecord(input.answers)).length > 0) title += ' — answered';
  return title;
}

function fileResult(result: ToolResult): ReactNode {
  const structured = asRecord(result.toolUseResult);
  const filenames = Array.isArray(structured.filenames)
    ? structured.filenames.map(String)
    : [];
  return (
    <div className="chat-file-list">
      {filenames.map((filename) => {
        const name = basename(filename);
        const directory = filename.slice(0, Math.max(0, filename.length - name.length));
        return (
          <div key={filename}>
            <span className="chat-file-dir">{directory}</span>
            <strong>{name}</strong>
          </div>
        );
      })}
    </div>
  );
}

function foundTitle(result: ToolResult): string {
  const structured = asRecord(result.toolUseResult);
  const filenames = Array.isArray(structured.filenames) ? structured.filenames : [];
  const count = isNumber(structured.numFiles) ? structured.numFiles : filenames.length;
  return `Found ${count} ${count === 1 ? 'file' : 'files'}`;
}

function terminalResult(result: ToolResult): string {
  const structured = asRecord(result.toolUseResult);
  const parts = [structured.stdout, structured.stderr]
    .filter((part): part is string => isString(part) && part.length > 0);
  return parts.length > 0 ? parts.join('\n') : textFromContent(result.content);
}

function firstLine(value: string): string {
  return value.trim().split('\n', 1)[0]?.trim() ?? '';
}

function structuredExitCode(result: ToolResult): number | undefined {
  const code = asRecord(result.toolUseResult).exit_code;
  return isNumber(code) ? code : undefined;
}

// Collapsed Bash rows show the exit code plus the first output line. Codex
// results carry exit_code; Claude success implies exit 0 (Bash errors on
// non-zero exit). Only called on success — errors use errorHint.
function bashHint(result: ToolResult): string {
  return `exit ${structuredExitCode(result) ?? 0} · ${firstLine(terminalResult(result)) || 'no output'}`;
}

function errorHint(result: ToolResult): string {
  const exitCode = structuredExitCode(result);
  const stderr = asRecord(result.toolUseResult).stderr;
  const error = isString(stderr) && stderr.length > 0
    ? stderr
    : terminalResult(result);
  return [
    ...exitCode !== undefined ? [`exit ${exitCode}`] : [],
    firstLine(error) || 'failed',
  ].join(' · ');
}

function scrollableResult(result: ToolResult): ReactNode {
  const text = textFromContent(result.content);
  return text ? <pre className="chat-tool-output">{text}</pre> : null;
}

function readContent(result: ToolResult, input: JsonObject): ReactNode {
  const file = asRecord(asRecord(result.toolUseResult).file);
  const text = isString(file.content) ? file.content : textFromContent(result.content);
  const path = stringValue(file.filePath) || stringValue(input.file_path);
  return <CodeView text={text} filename={basename(path)} />;
}

const toolRegistry = {
  Bash: {
    accent: 'green',
    getValue: (input) => stringValue(input.command),
    getSecondary: (input) => stringValue(input.description),
    terminalStyle: true,
    resultHint: bashHint,
    resultContent: (result) => (
      <pre className="chat-tool-output">{terminalResult(result)}</pre>
    ),
  },
  Read: {
    accent: 'faint',
    label: 'Read',
    getValue: (input) => basename(stringValue(input.file_path)),
    getDetail: (input) => stringValue(input.file_path),
    resultContent: readContent,
  },
  Edit: {
    accent: 'yellow',
    label: 'Edit',
    getValue: (input) => basename(stringValue(input.file_path)),
    content: (input) => <DiffContent input={input} badge="Edit" />,
  },
  Write: {
    accent: 'yellow',
    label: 'Write',
    getValue: (input) => basename(stringValue(input.file_path)),
    content: (input) => <WriteContent input={input} />,
  },
  ApplyPatch: {
    accent: 'yellow',
    label: 'Patch',
    getValue: (input) => basename(stringValue(input.file_path)),
    content: (input) => <DiffContent input={input} badge="Patch" />,
  },
  Grep: {
    accent: 'faint',
    label: 'Grep',
    getValue: (input) => stringValue(input.pattern),
    getSecondary: (input) => input.path ? `in ${String(input.path)}` : '',
    resultHint: foundTitle,
    resultContent: fileResult,
  },
  Glob: {
    accent: 'faint',
    label: 'Glob',
    getValue: (input) => stringValue(input.pattern),
    getSecondary: (input) => input.path ? `in ${String(input.path)}` : '',
    resultHint: foundTitle,
    resultContent: fileResult,
  },
  TodoWrite: {
    accent: 'magenta',
    title: () => 'Updating todo list',
    content: (input) => <TodoContent input={input} />,
    resultContent: () => <div className="chat-tool-success">Todo list updated</div>,
  },
  Task: {
    accent: 'magenta',
    title: (input) => {
      const agent = stringValue(input.subagent_type) || 'Agent';
      const description = stringValue(input.description) || 'Running task';
      return `Subagent / ${agent}: ${description}`;
    },
    content: (input) => <TaskContent input={input} />,
    resultHint: (result) => firstLine(textFromContent(result.content)),
    resultContent: (result) => (
      <ChatMarkdown>{textFromContent(result.content)}</ChatMarkdown>
    ),
  },
  AskUserQuestion: {
    accent: 'blue',
    title: questionTitle,
    defaultOpen: true,
    content: (input) => <QuestionsContent input={input} />,
  },
  ExitPlanMode: {
    accent: 'blue',
    plan: true,
    title: () => 'Implementation plan',
    defaultOpen: true,
    content: (input) => (
      <ChatMarkdown>{unescapeWithMathProtection(stringValue(input.plan))}</ChatMarkdown>
    ),
  },
  exit_plan_mode: {
    accent: 'blue',
    plan: true,
    title: () => 'Implementation plan',
    defaultOpen: true,
    content: (input) => (
      <ChatMarkdown>{unescapeWithMathProtection(stringValue(input.plan))}</ChatMarkdown>
    ),
  },
} satisfies Record<string, ToolRendererConfig>;

const TOOL_RENDERERS = new Map<string, ToolRendererConfig>(Object.entries(toolRegistry));

// Unknown tools show their input JSON highlighted; Raw would repeat it.
const defaultToolConfig: ToolRendererConfig = {
  accent: 'faint',
  content: (input) => <CodeView text={JSON.stringify(input, null, 2)} language="json" />,
};

export function ToolCallView({
  call,
  result,
}: {
  call: ToolUseBlock;
  result?: ToolResult;
}) {
  const config = TOOL_RENDERERS.get(call.name) ?? defaultToolConfig;
  const [open, setOpen] = useState(config.defaultOpen === true);
  const input = asRecord(call.input);
  const pending = call.input == null;

  const status = result === undefined ? 'running' : result.isError ? 'error' : 'ok';
  const value = pending ? '' : config.getValue?.(input) ?? '';
  const title = pending ? '' : config.title?.(input) ?? '';
  const secondary = pending ? '' : config.getSecondary?.(input) ?? '';
  const label = config.label
    ?? (pending || !(config.getValue || config.title || config.terminalStyle) ? call.name : '');
  const hint = open || result === undefined
    ? ''
    : result.isError
      ? errorHint(result)
      : config.resultHint?.(result) ?? '';
  // Expanded full text only where the row abbreviates: full command for
  // terminal rows, full path for Read. Diff headers already carry full paths.
  const detail = pending || !(config.getDetail || config.terminalStyle)
    ? ''
    : config.getDetail?.(input) ?? value;

  const resultBody: ReactNode = result === undefined
    ? null
    : result.isError
      ? <pre className="chat-tool-error">{terminalResult(result)}</pre>
      : config.resultContent?.(result, input) ?? scrollableResult(result);

  return (
    <div className="chat-tool-call" data-tool-name={call.name}>
      <div className={`chat-tool chat-tool--${config.accent}${config.plan ? ' chat-tool--plan' : ''}`}>
        <button
          type="button"
          className={`chat-tool-row${config.terminalStyle ? ' chat-tool-row--terminal' : ''}`}
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <span className="chat-tool-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
          {status === 'running' ? (
            <span
              className="webapp-inline-spinner chat-tool-status chat-tool-status--running"
              role="status"
              aria-label={`${call.name} running`}
            />
          ) : (
            <span
              className={`chat-tool-status chat-tool-status--${status}`}
              aria-label={status === 'error' ? `${call.name} failed` : `${call.name} completed`}
            />
          )}
          {label && <strong>{label}</strong>}
          {title && <span className="chat-tool-title">{title}</span>}
          {value && (config.terminalStyle ? (
            <span className="chat-tool-command">
              <span aria-hidden="true">$ </span>
              <code>{value}</code>
            </span>
          ) : <code>{value}</code>)}
          {pending && <span className="chat-tool-secondary">Pending…</span>}
          {secondary && <span className="chat-tool-secondary">{secondary}</span>}
          {hint && <span className="chat-tool-hint">{hint}</span>}
        </button>
        {open && !pending && (
          <div className="chat-tool-body">
            {detail && (
              <div className="chat-tool-full">
                {config.terminalStyle && <span aria-hidden="true">$ </span>}
                <code>{detail}</code>
                <CopyButton text={detail} label={config.terminalStyle ? 'Copy command' : 'Copy'} />
              </div>
            )}
            {config.content?.(input)}
            {resultBody}
            {config !== defaultToolConfig && <RawInput input={call.input} />}
          </div>
        )}
      </div>
    </div>
  );
}
