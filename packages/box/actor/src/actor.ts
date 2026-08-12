import { randomUUID } from "node:crypto";
import type {
  AgentContext,
  ContentBlock,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
  StopReason,
} from "@agentclientprotocol/sdk";
import { CredentialSource } from "./credentials.js";
import { Journal } from "./journal.js";
import { PROMPT_QUEUE_LIMIT, REPLAY_LIMIT } from "./config.js";
import type { AdapterFactory, AgentAdapter, Provider } from "./types.js";

export class Subscriber {
  public readonly sessions = new Set<string>();
  private context: AgentContext | undefined;

  public constructor(
    public readonly id: string,
    private readonly disconnect: () => void,
  ) {}

  public connect(context: AgentContext): void {
    this.context = context;
  }

  public close(): void {
    this.context = undefined;
    this.disconnect();
  }

  public update(sessionId: string, update: SessionUpdate): Promise<void> {
    if (!this.context) return Promise.reject(new Error("subscriber disconnected"));
    return this.context.notify("session/update", { sessionId, update });
  }

  public permission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (!this.context) return Promise.reject(new Error("subscriber disconnected"));
    return this.context.request("session/request_permission", request);
  }
}

type PendingPermission = {
  id: string;
  request: RequestPermissionRequest;
  attempted: Set<string>;
  promise: Promise<RequestPermissionResponse>;
  resolve: (response: RequestPermissionResponse) => void;
};

class SessionActor {
  private readonly subscribers = new Map<string, Subscriber>();
  private readonly permissions = new Map<string, PendingPermission>();
  private tail = Promise.resolve();
  private delivery = Promise.resolve();
  private queued = 0;
  private currentAbort: AbortController | undefined;

  public constructor(
    public readonly id: string,
    public readonly provider: Provider,
    public readonly cwd: string,
    private resumeId: string | null,
    private readonly adapter: AgentAdapter,
    private readonly journal: Journal,
    private readonly credentials: CredentialSource,
  ) {}

  public attach(subscriber: Subscriber, replay: boolean): Promise<void> {
    const operation = this.delivery.then(async () => {
      if (replay) {
        for (const event of this.journal.replay(this.id, REPLAY_LIMIT)) {
          const frame = JSON.parse(event.frame) as { params: { update: SessionUpdate } };
          await subscriber.update(this.id, frame.params.update);
        }
      }
      this.subscribers.set(subscriber.id, subscriber);
      subscriber.sessions.add(this.id);
      for (const permission of this.pendingPermissions()) this.askSubscriber(permission, subscriber);
    });
    this.delivery = operation.catch(() => undefined);
    return operation;
  }

  public detach(subscriber: Subscriber): void {
    this.subscribers.delete(subscriber.id);
    subscriber.sessions.delete(this.id);
  }

  public enqueue(prompt: ContentBlock[]): Promise<PromptResponse> {
    if (this.queued >= PROMPT_QUEUE_LIMIT) return Promise.reject(new Error("prompt queue is full"));
    this.queued += 1;
    const turnId = randomUUID();
    this.journal.startTurn(turnId, this.id);
    const result = this.tail.then(() => this.runTurn(turnId, prompt));
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      this.queued -= 1;
    });
  }

  public cancel(): void {
    this.currentAbort?.abort();
  }

  private async runTurn(turnId: string, prompt: ContentBlock[]): Promise<PromptResponse> {
    const abort = new AbortController();
    this.currentAbort = abort;
    let stopReason: StopReason = "refusal";
    try {
      const messageId = randomUUID();
      for (const content of prompt) {
        await this.emit({ sessionUpdate: "user_message_chunk", messageId, content });
      }
      let token: string | null;
      try {
        token = await this.credentials.token(this.provider);
      } catch {
        await this.visibleError("Credential mint failed; the prompt was not sent.");
        return { stopReason };
      }
      if (abort.signal.aborted) {
        stopReason = "cancelled";
        return { stopReason };
      }
      try {
        const output = await this.adapter.runTurn({
          sessionId: this.id,
          turnId,
          cwd: this.cwd,
          prompt,
          resumeId: this.resumeId,
          signal: abort.signal,
          token,
          emit: (update) => this.emit(update),
          requestPermission: (request) => this.requestPermission(request),
        });
        stopReason = abort.signal.aborted ? "cancelled" : output.stopReason;
        if (output.resumeId) {
          this.resumeId = output.resumeId;
          this.journal.setResumeId(this.id, output.resumeId);
        }
      } catch {
        if (abort.signal.aborted) {
          stopReason = "cancelled";
        } else {
          await this.visibleError("Agent stopped unexpectedly; the prompt was not retried.");
        }
      }
      return { stopReason };
    } finally {
      this.currentAbort = undefined;
      if (!this.journal.finishTurn(turnId, stopReason)) throw new Error("turn already reached a terminal state");
    }
  }

  private visibleError(text: string): Promise<void> {
    return this.emit({
      sessionUpdate: "agent_message_chunk",
      messageId: randomUUID(),
      content: { type: "text", text },
    });
  }

  private emit(update: SessionUpdate): Promise<void> {
    const operation = this.delivery.then(async () => {
      this.journal.append(this.id, {
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: this.id, update },
      });
      const subscribers = [...this.subscribers.values()];
      const settled = await Promise.allSettled(subscribers.map((subscriber) => subscriber.update(this.id, update)));
      let index = 0;
      for (const subscriber of subscribers) {
        if (settled[index]?.status === "rejected") subscriber.close();
        index += 1;
      }
    });
    this.delivery = operation.catch(() => undefined);
    return operation;
  }

  private requestPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const id = randomUUID();
    let resolve!: (response: RequestPermissionResponse) => void;
    const permission: PendingPermission = {
      id,
      request,
      attempted: new Set(),
      promise: new Promise((answer) => {
        resolve = answer;
      }),
      resolve,
    };
    this.permissions.set(id, permission);
    this.journal.addPermission(id, this.id, request);
    for (const subscriber of this.subscribers.values()) this.askSubscriber(permission, subscriber);
    const cancel = (): void => this.acceptPermission(permission, { outcome: { outcome: "cancelled" } });
    this.currentAbort?.signal.addEventListener("abort", cancel, { once: true });
    return permission.promise.finally(() => this.currentAbort?.signal.removeEventListener("abort", cancel));
  }

  private pendingPermissions(): PendingPermission[] {
    for (const stored of this.journal.pendingPermissions(this.id)) {
      if (this.permissions.has(stored.id)) continue;
      let resolve!: (response: RequestPermissionResponse) => void;
      const permission: PendingPermission = {
        id: stored.id,
        request: JSON.parse(stored.request) as RequestPermissionRequest,
        attempted: new Set(),
        promise: new Promise((answer) => {
          resolve = answer;
        }),
        resolve,
      };
      this.permissions.set(stored.id, permission);
    }
    return [...this.permissions.values()];
  }

  private askSubscriber(permission: PendingPermission, subscriber: Subscriber): void {
    if (permission.attempted.has(subscriber.id)) return;
    permission.attempted.add(subscriber.id);
    void subscriber.permission(permission.request).then(
      (response) => this.acceptPermission(permission, response),
      () => permission.attempted.delete(subscriber.id),
    );
  }

  private acceptPermission(permission: PendingPermission, response: RequestPermissionResponse): void {
    if (!validPermissionAnswer(permission.request, response)) return;
    if (!this.journal.answerPermission(permission.id, response)) return;
    this.permissions.delete(permission.id);
    permission.resolve(response);
  }
}

export class ActorService {
  private readonly sessions = new Map<string, SessionActor>();

  public constructor(
    private readonly journal: Journal,
    private readonly credentials: CredentialSource,
    private readonly adapters: AdapterFactory,
    private readonly defaultProvider: Provider,
  ) {}

  public async newSession(cwd: string, subscriber: Subscriber): Promise<string> {
    const id = randomUUID();
    this.journal.createSession({ id, provider: this.defaultProvider, cwd, resumeId: null });
    const actor = this.restore(id);
    await actor.attach(subscriber, false);
    return id;
  }

  public async loadSession(id: string, cwd: string, subscriber: Subscriber): Promise<void> {
    const stored = this.journal.session(id);
    if (!stored || stored.cwd !== cwd) throw new Error("unknown session");
    await this.restore(id).attach(subscriber, true);
  }

  public prompt(id: string, prompt: ContentBlock[]): Promise<PromptResponse> {
    return this.restore(id).enqueue(prompt);
  }

  public cancel(id: string): void {
    this.sessions.get(id)?.cancel();
  }

  public removeSubscriber(subscriber: Subscriber): void {
    for (const id of [...subscriber.sessions]) this.sessions.get(id)?.detach(subscriber);
  }

  private restore(id: string): SessionActor {
    const current = this.sessions.get(id);
    if (current) return current;
    const stored = this.journal.session(id);
    if (!stored) throw new Error("unknown session");
    const actor = new SessionActor(
      stored.id,
      stored.provider,
      stored.cwd,
      stored.resumeId,
      this.adapters(stored.provider),
      this.journal,
      this.credentials,
    );
    this.sessions.set(id, actor);
    return actor;
  }
}

function validPermissionAnswer(request: RequestPermissionRequest, response: RequestPermissionResponse): boolean {
  if (response.outcome.outcome === "cancelled") return true;
  const selected = response.outcome;
  return request.options.some(({ optionId }) => optionId === selected.optionId);
}
