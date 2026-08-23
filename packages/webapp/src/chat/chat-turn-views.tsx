import { useEffect, useState } from "react";
import { AssistantBlocks } from "./chat-blocks.js";
import { CopyButton, type ContentBlock, type ToolResult } from "./chat-render.js";
import { activitySummaryParts, type ChatItem, type ChatTurn } from "./chat-turns.js";

export function WorkingIndicator({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1_000));
  const words = ["Thinking…", "Processing…", "Analyzing…", "Working…"];
  const word = words[Math.floor(elapsed / 4) % words.length];
  return (
    <div className="chat-working" role="status">
      <span>{word}</span>
      <span>{elapsed}s</span>
    </div>
  );
}

export function ChatItemView({
  item,
  toolResults,
  showThinking,
  onOpenPreview,
  workingDirectory,
  finalAssistantId,
  finalTextOnly = false,
}: {
  item: ChatItem;
  toolResults: Record<string, import("./chat-render.js").ToolResult>;
  showThinking: boolean;
  onOpenPreview?: ((port: number) => boolean) | undefined;
  workingDirectory: string;
  finalAssistantId?: number | undefined;
  finalTextOnly?: boolean;
}) {
  if (item.kind === "user") {
    return (
      <div className="chat-msg chat-msg--user">
        <p>{item.text}</p>
      </div>
    );
  }
  if (item.kind === "error") return <div className="chat-error" role="alert">{item.text}</div>;
  if (item.kind === "system") return <div className="chat-system-row">{item.text}</div>;
  if (item.kind === "result") return null;

  const isFinal = item.id === finalAssistantId;
  const blocks = isFinal
    ? item.blocks.filter((block) => finalTextOnly ? block.type === "text" : block.type !== "text")
    : finalTextOnly ? [] : item.blocks;
  if (blocks.length === 0) return null;
  const copy = blocks
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  return (
    <div className={`chat-msg chat-msg--assistant${isFinal && finalTextOnly ? " chat-turn-response" : ""}`}>
      {copy && <CopyButton text={copy} label="Copy assistant message" />}
      <AssistantBlocks
        blocks={blocks}
        toolResults={toolResults}
        showThinking={showThinking}
        inFlight={item.inFlight}
        onOpenPreview={onOpenPreview}
        workingDirectory={workingDirectory}
      />
    </div>
  );
}

export function TurnWork({
  turn,
  toolResults,
  showThinking,
  onOpenPreview,
  workingDirectory,
}: {
  turn: ChatTurn;
  toolResults: Record<string, import("./chat-render.js").ToolResult>;
  showThinking: boolean;
  onOpenPreview?: ((port: number) => boolean) | undefined;
  workingDirectory: string;
}) {
  const activities = activitySummaryParts(turn.activity);
  const workItems = turn.items.filter((item) => {
    if (item.kind === "result") return false;
    if (item.kind !== "assistant" || item.id !== turn.finalAssistantId) return true;
    return item.blocks.some((block) => block.type !== "text");
  });

  if (workItems.length === 0 && activities.length === 0) return null;
  return (
    <div className={`chat-turn-work chat-turn-work--${turn.status}`}>
      <div className="chat-turn-work-body">
        {activities.length > 0 && (
          <div className="chat-turn-activity-summary">
            {activities.map((activity) => <div key={activity}>› {activity}</div>)}
          </div>
        )}
        {workItems.map((item) => (
          <ChatItemView
            key={item.id}
            item={item}
            toolResults={toolResults}
            showThinking={showThinking}
            onOpenPreview={onOpenPreview}
            workingDirectory={workingDirectory}
            finalAssistantId={turn.finalAssistantId}
          />
        ))}
      </div>
    </div>
  );
}

export function ChatTurnView({
  turn,
  toolResults,
  showThinking,
  onOpenPreview,
  workingDirectory,
}: {
  turn: ChatTurn;
  toolResults: Record<string, import("./chat-render.js").ToolResult>;
  showThinking: boolean;
  onOpenPreview?: ((port: number) => boolean) | undefined;
  workingDirectory: string;
}) {
  const finalAssistant = turn.finalAssistantId == null
    ? undefined
    : turn.items.find((item) => item.kind === "assistant" && item.id === turn.finalAssistantId);
  return (
    <article className={`chat-turn chat-turn--${turn.status}`}>
      <ChatItemView
        item={turn.prompt}
        toolResults={toolResults}
        showThinking={showThinking}
        onOpenPreview={onOpenPreview}
        workingDirectory={workingDirectory}
      />
      <TurnWork
        turn={turn}
        toolResults={toolResults}
        showThinking={showThinking}
        onOpenPreview={onOpenPreview}
        workingDirectory={workingDirectory}
      />
      {finalAssistant && (
        <ChatItemView
          item={finalAssistant}
          toolResults={toolResults}
          showThinking={showThinking}
          onOpenPreview={onOpenPreview}
          workingDirectory={workingDirectory}
          finalAssistantId={turn.finalAssistantId}
          finalTextOnly
        />
      )}
    </article>
  );
}

