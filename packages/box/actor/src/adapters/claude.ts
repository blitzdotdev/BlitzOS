import {
  query,
  type CanUseTool,
  type Options,
  type PermissionResult,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { hasObjectType, isString } from "../type-guards.js";
import type { AgentAdapter, TurnInput, TurnOutput } from "../types.js";

/** The real, pinned Claude Code binary — never the PATH shim.
 *
 * The shim at /usr/local/bin/claude mints a token for ITSELF and execs this
 * path, which is right for a terminal and wrong here: a probe or a turn routed
 * through it reports on the shim's own token rather than the one this process
 * was given, and answers "signed in" for a session whose next turn says "not
 * logged in". Absolute, so PATH cannot route it back through the shim.
 */
export const CLAUDE_BINARY = "/opt/blitz/npm/bin/claude";

/** The environment the SDK's engine runs in.
 *
 * Two things make this necessary rather than incidental.
 *
 * First, `options.env` REPLACES `process.env` in this SDK rather than merging
 * with it, so the spread is load-bearing: drop it and the engine loses the VM's
 * whole environment. HOME is then set explicitly, because HOME is what decides
 * which credential files the engine consults and inheriting an ambiguous one is
 * how a turn ends up reading somebody else's.
 *
 * Second, the token has to arrive HERE at all. The SDK spawns its own copy of
 * the Claude Code CLI, so the PATH shim that puts a token in front of every
 * other caller on the box never runs for a chat turn; this process has to mint
 * it and hand it over.
 *
 * CLAUDE_CODE_OAUTH_TOKEN, never ANTHROPIC_API_KEY: the broker mints an OAuth
 * access token (`sk-ant-oat01-…`), and the API-key path rejects it outright
 * while switching a subscription to per-token billing.
 *
 * No token is not an error. An unreachable or unconfigured broker leaves a turn
 * that runs and reports itself signed out, which a member can fix.
 *
 * A token carrying whitespace IS an error, and a loud one. The broker prints
 * the minted token with `fmt.Fprintln` and every hop down to
 * `CredentialSource.token` passes those bytes along, so a trailing newline is
 * the exact corruption this path has already shipped once. The terminal shim
 * survives it because `$(…)` strips it; an environment variable carries it to
 * the vendor intact, which answers 401 — indistinguishable, from the chat
 * panel, from a subscription that lapsed. Refusing here turns a hunt through
 * someone's billing page into one named failure at the boundary that made it.
 */
export function claudeEnv(
  token: string | null,
  base: NodeJS.ProcessEnv = process.env,
  home: string | undefined = base.HOME,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (home !== undefined) env.HOME = home;
  if (token) {
    if (/\s/u.test(token)) throw new Error("refusing to export a whitespace-bearing OAuth token");
    env.CLAUDE_CODE_OAUTH_TOKEN = token;
  }
  // The engine must not update itself out of the image pin mid-turn.
  env.DISABLE_AUTOUPDATER = "1";
  return env;
}

const PERMISSION_MODES: ReadonlySet<string> = new Set([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
]);

export function claudePermissionMode(value: string): NonNullable<Options["permissionMode"]> {
  // SAFETY: The set above holds exactly the PermissionMode literals the SDK accepts.
  return PERMISSION_MODES.has(value) ? (value as NonNullable<Options["permissionMode"]>) : "default";
}

const EFFORT_LEVELS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);

/** "default" (or anything unknown) leaves the SDK's own effort choice alone. */
export function claudeEffort(value: string): Options["effort"] | undefined {
  // SAFETY: The set above holds exactly the EffortLevel literals the SDK accepts.
  return EFFORT_LEVELS.has(value) ? (value as NonNullable<Options["effort"]>) : undefined;
}

export interface ClaudeStreamChunk {
  messageId: string;
  text?: string;
}

/** One assistant message keeps one id: stream records carry a fresh uuid per
 * event, so keying chunks on the record would split a reply into fragments. */
export function claudeStreamChunk(
  message: SDKMessage,
  currentMessageId: string,
): ClaudeStreamChunk {
  if (message.type !== "stream_event") return { messageId: currentMessageId };
  const event = message.event;
  if (event.type === "message_start") return { messageId: message.uuid };
  if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
    return { messageId: currentMessageId, text: event.delta.text };
  }
  return { messageId: currentMessageId };
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
    const options: Options = {
      abortController,
      canUseTool,
      cwd: input.cwd,
      env: claudeEnv(input.token, input.environment),
      includePartialMessages: true,
      pathToClaudeCodeExecutable: CLAUDE_BINARY,
      permissionMode: claudePermissionMode(input.config.permission),
      // The agent's rules live in ~/.claude/CLAUDE.md (installed each boot by
      // blitz-init-state), not in an appended system prompt. Load all
      // filesystem setting sources so that file is read. This is the SDK's own
      // documented default (settingSources omitted === ["user","project",
      // "local"]); passing it explicitly forces the `--setting-sources` flag on
      // the spawned CLI instead of relying on its implicit default, and
      // "project" is what enables CLAUDE.md discovery.
      settingSources: ["user", "project", "local"],
      systemPrompt: { type: "preset", preset: "claude_code" },
    };
    // Assigned rather than written into the literal as `resume: … ?? undefined`:
    // a fresh session must not carry the key at all, and this is the same
    // conditional-assignment shape `model` and `effort` already use, so the
    // three optional options read as one rule instead of three spellings.
    // `options` staying plainly typed `Options` is also what keeps a second
    // token-delivery hook off this object — `env` above is the only one, and
    // any `getOAuthToken` bolted back on is a typecheck failure rather than
    // something a reviewer has to catch.
    if (input.resumeId) options.resume = input.resumeId;
    if (input.config.model !== "default") options.model = input.config.model;
    const effort = claudeEffort(input.config.effort);
    if (effort !== undefined) options.effort = effort;
    let resumeId = input.resumeId ?? undefined;
    let stopReason: TurnOutput["stopReason"] = "refusal";
    let messageId = input.turnId;
    for await (const message of query({ prompt: promptText(input.prompt), options })) {
      const record = asRecord(message);
      if (isString(record.session_id)) resumeId = record.session_id;
      const chunk = claudeStreamChunk(message, messageId);
      messageId = chunk.messageId;
      if (chunk.text !== undefined) {
        await input.emit({
          sessionUpdate: "agent_message_chunk",
          messageId,
          content: { type: "text", text: chunk.text },
        });
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
