import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { hasObjectType, isNumber, isString } from "../type-guards.js";
import type { AgentAdapter, TurnInput, TurnOutput } from "../types.js";

type JsonObject = Record<string, unknown>;
type Pending = { resolve(value: unknown): void; reject(error: Error): void };
export type ThreadRequestParams = {
  threadId?: string;
  cwd?: string;
  approvalPolicy?: "on-request";
  sandbox?: "workspace-write";
};

export function codexThreadRequestParams(
  input: Pick<TurnInput, "resumeId" | "cwd">,
): ThreadRequestParams {
  const params: ThreadRequestParams = {};
  if (input.resumeId) params.threadId = input.resumeId;
  params.cwd = input.cwd;
  params.approvalPolicy = "on-request";
  params.sandbox = "workspace-write";
  return params;
}

class AppServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  public constructor(
    private readonly notify: (method: string, params: JsonObject) => Promise<void>,
    private readonly serverRequest: (method: string, params: JsonObject) => Promise<unknown>,
  ) {
    this.child = spawn("codex", ["app-server", "--stdio"], {
      cwd: "/workspace",
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.resume();
    createInterface({ input: this.child.stdout }).on("line", (line) => this.receive(line));
    this.child.once("exit", () => {
      for (const pending of this.pending.values()) pending.reject(new Error("codex app-server exited"));
      this.pending.clear();
    });
  }

  public request(method: string, params: JsonObject = {}): Promise<unknown> {
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.write({ jsonrpc: "2.0", id, method, params });
    return result;
  }

  public notification(method: string, params: JsonObject = {}): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  public close(): void {
    this.child.stdin.end();
    this.child.kill("SIGTERM");
  }

  private receive(line: string): void {
    let message: JsonObject;
    try {
      // SAFETY: JSON parsing establishes valid JSON only. TODO(deslop-tier-c): validate that each subprocess line is a JSON-RPC object before property access.
      message = JSON.parse(line) as JsonObject;
    } catch {
      this.close();
      return;
    }
    if (isString(message.method)) {
      const params = asRecord(message.params);
      if (isNumber(message.id)) {
        void this.serverRequest(message.method, params).then(
          (result) => this.write({ jsonrpc: "2.0", id: message.id, result }),
          () => this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "Request failed" } }),
        );
      } else {
        void this.notify(message.method, params);
      }
      return;
    }
    if (!isNumber(message.id)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error("codex app-server request failed"));
    else pending.resolve(message.result);
  }

  private write(message: JsonObject): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

export class CodexAdapter implements AgentAdapter {
  public async runTurn(input: TurnInput): Promise<TurnOutput> {
    let complete!: (output: TurnOutput) => void;
    const completed = new Promise<TurnOutput>((resolve) => {
      complete = resolve;
    });
    let token = input.token;
    const server = new AppServer(
      async (method, params) => {
        if (method === "item/agentMessage/delta" && isString(params.delta)) {
          await input.emit({
            sessionUpdate: "agent_message_chunk",
            messageId: isString(params.itemId) ? params.itemId : input.turnId,
            content: { type: "text", text: params.delta },
          });
        } else if (method === "turn/plan/updated") {
          const plan = Array.isArray(params.plan) ? params.plan : [];
          await input.emit({
            sessionUpdate: "plan",
            entries: plan.map((value) => {
              const item = asRecord(value);
              return {
                content: isString(item.step) ? item.step : "",
                priority: "medium" as const,
                status: item.status === "inProgress" ? "in_progress" : item.status === "completed" ? "completed" : "pending",
              };
            }),
          });
        } else if (method === "item/started") {
          const item = asRecord(params.item);
          const update = toolUpdate(item, "pending");
          if (update) await input.emit(update);
        } else if (method === "item/completed") {
          const item = asRecord(params.item);
          const update = toolUpdate(item, "completed");
          if (update) await input.emit(update);
        } else if (method === "turn/completed") {
          const turn = asRecord(params.turn);
          complete({
            stopReason: turn.status === "interrupted" ? "cancelled" : turn.status === "completed" ? "end_turn" : "refusal",
            resumeId: input.resumeId ?? undefined,
          });
        }
      },
      async (method, params) => {
        if (method === "account/chatgptAuthTokens/refresh" && token) return codexAuth(token);
        if (method !== "item/commandExecution/requestApproval" && method !== "item/fileChange/requestApproval") {
          throw new Error("unsupported codex request");
        }
        const itemId = isString(params.itemId) ? params.itemId : crypto.randomUUID();
        const answer = await input.requestPermission({
          sessionId: input.sessionId,
          toolCall: {
            toolCallId: itemId,
            title:
              isString(params.command)
                ? params.command
                : isString(params.reason)
                  ? params.reason
                  : "Apply file changes",
            kind: method.includes("commandExecution") ? "execute" : "edit",
            status: "pending",
            rawInput: params,
          },
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        });
        const decision =
          answer.outcome.outcome === "selected" && answer.outcome.optionId === "allow-once" ? "accept" : "decline";
        return { decision };
      },
    );
    try {
      await server.request("initialize", {
        clientInfo: { name: "blitz-box", title: "BlitzOS box", version: "0.1.0" },
        capabilities: null,
      });
      server.notification("initialized");
      if (token) await server.request("account/login/start", { type: "chatgptAuthTokens", ...codexAuth(token) });
      const threadParams = codexThreadRequestParams(input);
      const threadResult = asRecord(
        await server.request(input.resumeId ? "thread/resume" : "thread/start", threadParams),
      );
      const thread = asRecord(threadResult.thread);
      const threadId = isString(thread.id) ? thread.id : input.resumeId;
      if (!threadId) throw new Error("codex returned no thread ID");
      token = input.token;
      const turnResult = asRecord(
        await server.request("turn/start", {
          threadId,
          input: [{ type: "text", text: promptText(input.prompt), text_elements: [] }],
        }),
      );
      const turn = asRecord(turnResult.turn);
      const turnId = isString(turn.id) ? turn.id : undefined;
      const interrupt = (): void => {
        if (turnId) void server.request("turn/interrupt", { threadId, turnId });
      };
      input.signal.addEventListener("abort", interrupt, { once: true });
      const output = await completed;
      input.signal.removeEventListener("abort", interrupt);
      return { ...output, resumeId: threadId };
    } finally {
      server.close();
    }
  }
}

function toolUpdate(item: JsonObject, status: "pending" | "completed"): SessionUpdate | undefined {
  if (!isString(item.id) || !isString(item.type)) return undefined;
  if (status === "completed") {
    if (!["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall"].includes(item.type)) return undefined;
    return { sessionUpdate: "tool_call_update" as const, toolCallId: item.id, status };
  }
  const kind: "execute" | "edit" | "other" =
    item.type === "commandExecution" ? "execute" : item.type === "fileChange" ? "edit" : "other";
  if (kind === "other" && item.type !== "mcpToolCall" && item.type !== "dynamicToolCall") return undefined;
  return {
    sessionUpdate: "tool_call" as const,
    toolCallId: item.id,
    title: isString(item.command) ? item.command : item.type,
    kind,
    status,
    rawInput: item,
  };
}

interface CodexAuth {
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType: null;
}

function codexAuth(accessToken: string): CodexAuth {
  const claims = asRecord(JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8")));
  const account =
    claims["https://api.openai.com/auth.chatgpt_account_id"] ?? claims.chatgpt_account_id ?? claims.account_id;
  if (!isString(account) || !account) throw new Error("codex token has no account ID");
  return { accessToken, chatgptAccountId: account, chatgptPlanType: null };
}

function promptText(blocks: TurnInput["prompt"]): string {
  return blocks
    .map((block) => (block.type === "text" ? block.text : block.type === "resource_link" ? `${block.name}: ${block.uri}` : JSON.stringify(block)))
    .join("\n");
}

function asRecord(value: unknown): JsonObject {
  // SAFETY: The preceding checks establish only a non-null, non-array object record; JSON-RPC fields remain unvalidated.
  return value && hasObjectType(value) && !Array.isArray(value) ? (value as JsonObject) : {};
}
