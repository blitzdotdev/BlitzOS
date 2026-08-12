import type { ContentBlock, ToolCallContent } from "@agentclientprotocol/sdk";
import type { ChatState } from "./reducer.js";

export function ChatTranscript({
  state,
  onPermission,
}: {
  state: ChatState;
  onPermission: (toolCallId: string, optionId: string) => void;
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
              {message.text.length > 0 && <pre>{message.text}</pre>}
              {message.otherContent.map((content, index) => <ContentView key={index} content={content} />)}
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
              {tool.content.map((content, index) => <ToolContentView key={index} content={content} />)}
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

function ContentView({ content }: { content: ContentBlock }): React.JSX.Element {
  if (content.type === "text") return <pre>{content.text}</pre>;
  if (content.type === "resource_link") return <p>{content.title ?? content.name}: {content.uri}</p>;
  if (content.type === "resource") {
    return "text" in content.resource
      ? <pre>{content.resource.text}</pre>
      : <p>Embedded resource: {content.resource.uri}</p>;
  }
  if (content.type === "image") return <img className="chat-image" alt="Agent-provided content" src={`data:${content.mimeType};base64,${content.data}`} />;
  return <p>Audio content ({content.mimeType})</p>;
}

function ToolContentView({ content }: { content: ToolCallContent }): React.JSX.Element {
  if (content.type === "content") return <ContentView content={content.content} />;
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
    text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    text = "Unavailable";
  }
  return <details><summary>{label}</summary><pre>{text}</pre></details>;
}
