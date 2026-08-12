import { query, type CanUseTool, type Options, type PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { AgentAdapter, TurnInput, TurnOutput } from "../types.js";

type TokenOptions = Options & {
  getOAuthToken?: (options: { signal: AbortSignal }) => Promise<string>;
};

export class ClaudeAdapter implements AgentAdapter {
  public async runTurn(input: TurnInput): Promise<TurnOutput> {
    const abortController = new AbortController();
    input.signal.addEventListener("abort", () => abortController.abort(), { once: true });
    const canUseTool: CanUseTool = async (toolName, toolInput, options) => {
      const answer = await input.requestPermission({
        sessionId: input.sessionId,
        toolCall: {
          toolCallId: options.toolUseID,
          title: options.title ?? options.displayName ?? toolName,
          kind: toolKind(toolName),
          status: "pending",
          rawInput: toolInput,
        },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      });
      const result: PermissionResult =
        answer.outcome.outcome === "selected" && answer.outcome.optionId === "allow-once"
          ? { behavior: "allow", updatedInput: toolInput }
          : { behavior: "deny", message: "The user rejected this operation." };
      return result;
    };
    const options: TokenOptions = {
      abortController,
      canUseTool,
      cwd: input.cwd,
      includePartialMessages: true,
      pathToClaudeCodeExecutable: "/usr/local/bin/claude",
      permissionMode: "default",
      ...(input.resumeId ? { resume: input.resumeId } : {}),
      ...(input.token ? { getOAuthToken: async () => input.token as string } : {}),
    };
    let resumeId = input.resumeId ?? undefined;
    let stopReason: TurnOutput["stopReason"] = "refusal";
    for await (const message of query({ prompt: promptText(input.prompt), options })) {
      const record = asRecord(message);
      if (typeof record.session_id === "string") resumeId = record.session_id;
      if (record.type === "stream_event") {
        const event = asRecord(record.event);
        const delta = asRecord(event.delta);
        if (event.type === "content_block_delta" && delta.type === "text_delta" && typeof delta.text === "string") {
          await input.emit({
            sessionUpdate: "agent_message_chunk",
            messageId: typeof record.uuid === "string" ? record.uuid : input.turnId,
            content: { type: "text", text: delta.text },
          });
        }
      }
      if (record.type === "result") stopReason = record.subtype === "success" ? "end_turn" : "refusal";
    }
    return { stopReason, ...(resumeId ? { resumeId } : {}) };
  }
}

function promptText(blocks: TurnInput["prompt"]): string {
  return blocks
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "resource_link") return `${block.name}: ${block.uri}`;
      return JSON.stringify(block);
    })
    .join("\n");
}

function toolKind(name: string): "read" | "edit" | "delete" | "execute" | "other" {
  if (name === "Read" || name === "Glob" || name === "Grep") return "read";
  if (name === "Edit" || name === "Write" || name === "NotebookEdit") return "edit";
  if (name === "Bash") return "execute";
  return "other";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
