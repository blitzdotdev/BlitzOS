import type { ContentBlock, ToolCallContent } from "@agentclientprotocol/sdk";
import type { MouseEvent, ReactNode } from "react";
import { previewPortFromLocalUrl } from "../preview.js";
import { isString } from "../type-guards.js";
import type { ChatState } from "./reducer.js";

export function ChatTranscript({
  state,
  onPermission,
  onOpenPreview,
}: {
  state: ChatState;
  onPermission: (toolCallId: string, optionId: string) => void;
  onOpenPreview?: (port: number) => boolean;
}): React.JSX.Element {
  return (
    <div className="chat-transcript" aria-live="polite">
      {state.rows.map((row) => {
        if (row.kind === "message") {
          const message = state.messages[row.id];
          if (message === undefined) return null;
          return (
            <article className={`chat-message ${message.role}`} key={`${row.kind}:${row.id}`}>
              <p className="message-role">{message.role === "user" ? "You" : message.role === "agent" ? "Agent" : "Agent thought"}</p>
              {message.text.length > 0 && <LinkedText text={message.text} onOpenPreview={onOpenPreview} />}
              {message.otherContent.map((content, index) => (
                <ContentView key={index} content={content} onOpenPreview={onOpenPreview} />
              ))}
            </article>
          );
        }
        if (row.kind === "tool") {
          const tool = state.tools[row.id];
          if (tool === undefined) return null;
          return (
            <article className="tool-row" key={`${row.kind}:${row.id}`}>
              <div className="tool-heading">
                <strong>{tool.title}</strong>
                <span>{[tool.kind, tool.status].filter(Boolean).join(" · ")}</span>
              </div>
              {tool.content.map((content, index) => (
                <ToolContentView key={index} content={content} onOpenPreview={onOpenPreview} />
              ))}
              {tool.rawInput !== undefined && <JsonDetails label="Input" value={tool.rawInput} />}
              {tool.rawOutput !== undefined && <JsonDetails label="Output" value={tool.rawOutput} />}
            </article>
          );
        }
        if (row.kind === "plan") {
          if (state.plan === null) return null;
          return (
            <article className="plan-row" key="plan">
              <strong>Plan</strong>
              <ol>{state.plan.map((entry, index) => <li key={index} data-status={entry.status}>{entry.content}</li>)}</ol>
            </article>
          );
        }
        if (row.kind === "permission") {
          const permission = state.permissions[row.id];
          if (permission === undefined) return null;
          const answered = permission.answeredOptionId !== null || permission.cancelled;
          return (
            <article className="permission-row" key={`${row.kind}:${row.id}`}>
              <strong>{permission.title}</strong>
              <div className="button-row">
                {permission.options.map((option) => (
                  <button
                    className="cockpit-action"
                    type="button"
                    key={option.optionId}
                    disabled={answered}
                    onClick={() => onPermission(permission.toolCallId, option.optionId)}
                  >
                    {option.name}
                  </button>
                ))}
              </div>
              {answered && (
                <small>
                  Answered: {permission.cancelled
                    ? "cancelled"
                    : permission.options.find(({ optionId }) => optionId === permission.answeredOptionId)?.name ?? "selected"}
                </small>
              )}
            </article>
          );
        }
        return <div className="generic-row" key={`${row.kind}:${row.id}`}>{row.label}</div>;
      })}
    </div>
  );
}

function previewLinkClick(
  event: MouseEvent<HTMLAnchorElement>,
  href: string,
  onOpenPreview?: (port: number) => boolean,
): void {
  const port = previewPortFromLocalUrl(href);
  if (port !== null && onOpenPreview?.(port)) event.preventDefault();
}

function LinkedText({
  text,
  onOpenPreview,
}: {
  text: string;
  onOpenPreview?: (port: number) => boolean;
}): React.JSX.Element {
  const pieces: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<]+/gu)) {
    const index = match.index;
    const href = match[0];
    if (index > cursor) pieces.push(text.slice(cursor, index));
    pieces.push(
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        key={`${index}:${href}`}
        onClick={(event) => previewLinkClick(event, href, onOpenPreview)}
      >{href}</a>,
    );
    cursor = index + href.length;
  }
  if (cursor < text.length) pieces.push(text.slice(cursor));
  return <pre>{pieces}</pre>;
}

function ContentView({
  content,
  onOpenPreview,
}: {
  content: ContentBlock;
  onOpenPreview?: (port: number) => boolean;
}): React.JSX.Element {
  if (content.type === "text") return <LinkedText text={content.text} onOpenPreview={onOpenPreview} />;
  if (content.type === "resource_link") {
    return (
      <p>
        {content.title ?? content.name}:{' '}
        <a
          href={content.uri}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => previewLinkClick(event, content.uri, onOpenPreview)}
        >{content.uri}</a>
      </p>
    );
  }
  if (content.type === "resource") {
    return "text" in content.resource
      ? <pre>{content.resource.text}</pre>
      : <p>Embedded resource: {content.resource.uri}</p>;
  }
  if (content.type === "image") return <img className="chat-image" alt="Agent-provided content" src={`data:${content.mimeType};base64,${content.data}`} />;
  return <p>Audio content ({content.mimeType})</p>;
}

function ToolContentView({
  content,
  onOpenPreview,
}: {
  content: ToolCallContent;
  onOpenPreview?: (port: number) => boolean;
}): React.JSX.Element {
  if (content.type === "content") {
    return <ContentView content={content.content} onOpenPreview={onOpenPreview} />;
  }
  if (content.type === "terminal") return <p className="terminal-reference">Terminal {content.terminalId}</p>;
  return (
    <div className="diff-view">
      <strong>{content.path}</strong>
      {content.oldText != null && <pre className="diff-old">{content.oldText}</pre>}
      <pre className="diff-new">{content.newText}</pre>
    </div>
  );
}

function JsonDetails({ label, value }: { label: string; value: unknown }): React.JSX.Element {
  let text: string;
  try {
    text = isString(value) ? value : JSON.stringify(value, null, 2);
  } catch {
    text = "Unavailable";
  }
  return <details><summary>{label}</summary><pre>{text}</pre></details>;
}
