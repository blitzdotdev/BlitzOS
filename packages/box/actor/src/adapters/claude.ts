import { query, type CanUseTool, type Options, type PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { hasObjectType, isString } from "../type-guards.js";
import type { AgentAdapter, TurnInput, TurnOutput } from "../types.js";

type TokenOptions = Options & {
  getOAuthToken?: (options: { signal: AbortSignal }) => Promise<string>;
};

interface ClaudeOptionalOptions {
  resume?: string;
  getOAuthToken?: TokenOptions["getOAuthToken"];
}

export function claudeOptionalOptions(
  input: Pick<TurnInput, "resumeId" | "token">,
): ClaudeOptionalOptions {
  const options: ClaudeOptionalOptions = {};
  if (input.resumeId) options.resume = input.resumeId;
  if (input.token) {
    // SAFETY: This branch is evaluated only when the nullable string token is truthy.
    options.getOAuthToken = async () => input.token as string;
  }
  return options;
}

export function claudeTurnOutput(
  stopReason: TurnOutput["stopReason"],
  resumeId: string | undefined,
): TurnOutput {
  const output: TurnOutput = { stopReason };
  if (resumeId) output.resumeId = resumeId;
  return output;
}

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
    };
    Object.assign(options, claudeOptionalOptions(input));
    let resumeId = input.resumeId ?? undefined;
    let stopReason: TurnOutput["stopReason"] = "refusal";
    for await (const message of query({ prompt: promptText(input.prompt), options })) {
      const record = asRecord(message);
      if (isString(record.session_id)) resumeId = record.session_id;
      if (record.type === "stream_event") {
        const event = asRecord(record.event);
        const delta = asRecord(event.delta);
        if (event.type === "content_block_delta" && delta.type === "text_delta" && isString(delta.text)) {
          await input.emit({
            sessionUpdate: "agent_message_chunk",
            messageId: isString(record.uuid) ? record.uuid : input.turnId,
            content: { type: "text", text: delta.text },
          });
        }
      }
      if (record.type === "result") stopReason = record.subtype === "success" ? "end_turn" : "refusal";
    }
    return claudeTurnOutput(stopReason, resumeId);
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
  // SAFETY: The preceding checks establish only a non-null, non-array object record; individual SDK fields remain unvalidated.
  return value && hasObjectType(value) && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
