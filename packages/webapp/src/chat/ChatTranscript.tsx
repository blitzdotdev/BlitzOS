import type { ContentBlock } from "@agentclientprotocol/sdk";
import {
  ChatMarkdown,
  CopyButton,
  PreviewLinkContext,
  ThinkingView,
  ToolRowView,
} from "./chat-render.js";
import type { ChatPermission, ChatState } from "./reducer.js";

export function ChatTranscript({
  state,
  showThinking,
  onPermission,
  onOpenPreview,
}: {
  state: ChatState;
  showThinking: boolean;
  onPermission: (toolCallId: string, optionId: string) => void;
  onOpenPreview?: (port: number) => boolean;
}): React.JSX.Element {
  const lastAgentRowId = [...state.rows].reverse().find((row) =>
    row.kind === "message" && state.messages[row.id]?.role === "agent",
  )?.id;
  return (
    <PreviewLinkContext.Provider value={onOpenPreview}>
      {state.rows.map((row) => {
        if (row.kind === "message") {
          const message = state.messages[row.id];
          if (message === undefined) return null;
          if (message.role === "user") {
            return (
              <div key={`${row.kind}:${row.id}`} className="chat-msg chat-msg--user">
                {message.text}
                {message.otherContent.map((content, index) => (
                  <ExtraContent key={index} content={content} />
                ))}
              </div>
            );
          }
          if (message.role === "thought") {
            if (!showThinking) return null;
            return <ThinkingView key={`${row.kind}:${row.id}`} text={message.text} />;
          }
          return (
            <div key={`${row.kind}:${row.id}`} className="chat-msg chat-msg--assistant">
              {message.text.length > 0 && <CopyButton text={message.text} label="Copy assistant message" />}
              <div className="chat-assistant-text">
                <ChatMarkdown>{message.text}</ChatMarkdown>
                {state.running && row.id === lastAgentRowId && <span className="chat-stream-cursor">▍</span>}
              </div>
              {message.otherContent.map((content, index) => (
                <ExtraContent key={index} content={content} />
              ))}
            </div>
          );
        }
        if (row.kind === "tool") {
          const tool = state.tools[row.id];
          if (tool === undefined) return null;
          return <ToolRowView key={`${row.kind}:${row.id}`} tool={tool} />;
        }
        if (row.kind === "plan") {
          if (state.plan === null) return null;
          return (
            <ul className="chat-todos" key="plan">
              {state.plan.map((entry, index) => {
                const glyph = entry.status === "completed" ? "●" : entry.status === "in_progress" ? "◐" : "○";
                return (
                  <li key={`${index}:${entry.content}`} className={`chat-todo chat-todo--${entry.status}`}>
                    <span aria-hidden="true">{glyph}</span>
                    <span>{entry.content}</span>
                  </li>
                );
              })}
            </ul>
          );
        }
        if (row.kind === "permission") {
          const permission = state.permissions[row.id];
          if (permission === undefined) return null;
          return (
            <ApprovalView
              key={`${row.kind}:${row.id}`}
              permission={permission}
              onPermission={onPermission}
            />
          );
        }
        return <div className="chat-system-row" key={`${row.kind}:${row.id}`}>{row.label}</div>;
      })}
    </PreviewLinkContext.Provider>
  );
}

function ApprovalView({
  permission,
  onPermission,
}: {
  permission: ChatPermission;
  onPermission: (toolCallId: string, optionId: string) => void;
}): React.JSX.Element {
  const answered = permission.answeredOptionId !== null || permission.cancelled;
  return (
    <div className="chat-approval" role="alertdialog" aria-label="Tool approval">
      <div className="chat-approval-title">{permission.title}</div>
      <div className="chat-approval-actions">
        {permission.options.map((option) => (
          <button
            type="button"
            key={option.optionId}
            className={option.kind.startsWith("reject") ? "chat-approval-deny" : undefined}
            disabled={answered}
            onClick={() => onPermission(permission.toolCallId, option.optionId)}
          >
            {option.name}
          </button>
        ))}
      </div>
      {answered && (
        <div className="chat-result-meta">
          {permission.cancelled
            ? "Cancelled"
            : permission.options.find(({ optionId }) => optionId === permission.answeredOptionId)?.name ?? "Answered"}
          {permission.answeredBy && ` · ${permission.answeredBy.name ?? permission.answeredBy.userId}`}
        </div>
      )}
    </div>
  );
}

function ExtraContent({ content }: { content: ContentBlock }): React.JSX.Element | null {
  if (content.type === "text") return <ChatMarkdown>{content.text}</ChatMarkdown>;
  if (content.type === "image") {
    return <img className="chat-image" alt="Agent-provided content" src={`data:${content.mimeType};base64,${content.data}`} />;
  }
  if (content.type === "resource_link") {
    return <a href={content.uri} target="_blank" rel="noreferrer">{content.title ?? content.name}</a>;
  }
  if (content.type === "resource" && "text" in content.resource) {
    return <pre className="chat-tool-output">{content.resource.text}</pre>;
  }
  return null;
}
