import { randomUUID } from "node:crypto";
import type {
  AgentContext,
  ContentBlock,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionUpdate,
  StopReason,
} from "@agentclientprotocol/sdk";
import {
  agentConfigOptions,
  applyAgentConfig,
  defaultAgentConfig,
  type AgentConfig,
} from "./agent-config.js";
import { CredentialSource } from "./credentials.js";
import { ChatSessionStore } from "./chat-session.js";
import { PROMPT_QUEUE_LIMIT, REPLAY_LIMIT } from "./config.js";
import type { AdapterFactory, AgentAdapter, Provider } from "./types.js";
import type { ConnectionIdentity } from "./auth.js";
import type {
  AuthRequiredFrame,
  JournalFrame,
  OutboundFrame,
  PermissionAnsweredFrame,
  SessionUpdateFrame,
} from "./chat-session.js";

export interface ActorSessionSummary {
  id: string;
  provider: Provider;
  createdBy: string;
  updatedAt: number;
}

function attributedActor(identity: ConnectionIdentity) {
  return { userId: identity.userId, name: identity.name };
}

export class Subscriber {
  public readonly sessions = new Set<string>();
  private context: AgentContext | undefined;

  public constructor(
    public readonly id: string,
    public readonly identity: ConnectionIdentity,
    private readonly disconnect: () => void,
  ) {}

  public connect(context: AgentContext): void {
    this.context = context;
  }

  public close(): void {
    this.context = undefined;
    this.disconnect();
  }

  public deliver(frame: OutboundFrame): Promise<void> {
    if (!this.context) return Promise.reject(new Error("subscriber disconnected"));
    const method: string = frame.method;
    return this.context.notify<OutboundFrame["params"]>(method, frame.params);
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
  private abortIdentity: ConnectionIdentity | undefined;
  private config: AgentConfig;

  public constructor(
    public readonly id: string,
    public readonly provider: Provider,
    public readonly cwd: string,
    private resumeId: string | null,
    private readonly adapter: AgentAdapter,
    private readonly store: ChatSessionStore,
    private readonly credentials: CredentialSource,
  ) {
    this.config = defaultAgentConfig(provider);
  }

  public configOptions(): SessionConfigOption[] {
    return agentConfigOptions(this.provider, this.config);
  }

  public setConfigOption(configId: string, valueId: string): SessionConfigOption[] {
    this.config = applyAgentConfig(this.provider, this.config, configId, valueId);
    return this.configOptions();
  }

  public attach(subscriber: Subscriber, replay: boolean): Promise<void> {
    const operation = this.delivery.then(async () => {
      if (replay) {
        for (const event of this.store.replay(this.id, REPLAY_LIMIT)) {
          // SAFETY: Journaled frames are written only from the two ActorService-owned outbound frame constructors; persisted rows are not revalidated here. TODO(deslop-tier-c): validate replayed journal JSON before delivery.
          const frame = JSON.parse(event.frame) as JournalFrame;
          await subscriber.deliver(frame);
        }
      }
      this.subscribers.set(subscriber.id, subscriber);
      subscriber.sessions.add(this.id);
      // Pending permissions live in memory only: one can exist only while its
      // turn's adapter runs in this process, so there is nothing to restore
      // from disk. Answered ones replay above as blitz/permission_answered.
      for (const permission of this.permissions.values()) this.askSubscriber(permission, subscriber);
    });
    this.delivery = operation.catch(() => undefined);
    return operation;
  }

  public detach(subscriber: Subscriber): void {
    this.subscribers.delete(subscriber.id);
    subscriber.sessions.delete(this.id);
  }

  public enqueue(prompt: ContentBlock[], identity: ConnectionIdentity): Promise<PromptResponse> {
    if (this.queued >= PROMPT_QUEUE_LIMIT) return Promise.reject(new Error("prompt queue is full"));
    this.queued += 1;
    const turnId = randomUUID();
    const result = this.tail.then(() => this.runTurn(turnId, prompt, identity));
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      this.queued -= 1;
    });
  }

  public cancel(identity: ConnectionIdentity): void {
    this.abortIdentity = identity;
    this.currentAbort?.abort();
  }

  private async runTurn(turnId: string, prompt: ContentBlock[], identity: ConnectionIdentity): Promise<PromptResponse> {
    const abort = new AbortController();
    this.currentAbort = abort;
    let stopReason: StopReason = "refusal";
    try {
      const messageId = randomUUID();
      for (const content of prompt) {
        await this.emit({ sessionUpdate: "user_message_chunk", messageId, content }, identity);
      }
      let token: string | null;
      try {
        token = await this.credentials.token(this.provider);
      } catch {
        // A throw means a broker is wired up and refused to mint, so the user
        // has a harness to sign back in to. The null return is the opposite
        // case — no broker at all — which is a legitimate signed-out-but-fine
        // state with nothing to sign in to, so it stays silent.
        await this.announceAuthRequired();
        await this.visibleError("Credential mint failed; the prompt was not sent.", identity);
        return { stopReason };
      }
      if (abort.signal.aborted) {
        stopReason = "cancelled";
        return { stopReason };
      }
      // Placed after the mint so a turn that is about to abandon ship over
      // credentials never pays for this, and before the read below because the
      // sync is what puts the integration's variables in creds/env.d and its
      // skill under .claude/skills in the first place — the harness scans
      // skills once, at spawn, so anything that lands later is invisible for
      // the whole turn. It swallows every failure itself.
      await this.credentials.sync();
      // Workspace variables are optional configuration: this call degrades to
      // the actor's own environment rather than failing the prompt.
      const environment = await this.credentials.environment();
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
          environment,
          config: this.config,
          emit: (update) => this.emit(update, identity),
          requestPermission: (request) => this.requestPermission(request, identity),
        });
        stopReason = abort.signal.aborted ? "cancelled" : output.stopReason;
        if (output.resumeId) {
          this.resumeId = output.resumeId;
          this.store.setResumeId(this.id, output.resumeId);
        }
      } catch {
        if (abort.signal.aborted) {
          stopReason = "cancelled";
        } else {
          await this.visibleError("Agent stopped unexpectedly; the prompt was not retried.", identity);
        }
      }
      return { stopReason };
    } finally {
      this.currentAbort = undefined;
      this.abortIdentity = undefined;
    }
  }

  private visibleError(text: string, identity: ConnectionIdentity): Promise<void> {
    return this.emit({
      sessionUpdate: "agent_message_chunk",
      messageId: randomUUID(),
      content: { type: "text", text },
    }, identity);
  }

  private emit(update: SessionUpdate, identity: ConnectionIdentity): Promise<void> {
    const operation = this.delivery.then(async () => {
      const frame: SessionUpdateFrame = {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: this.id,
          update,
          actor: attributedActor(identity),
        },
      };
      this.store.append(this.id, frame);
      await this.fanout(frame);
    });
    this.delivery = operation.catch(() => undefined);
    return operation;
  }

  /** Live-only sibling of {@link emit}: the frame is never journaled, so a
   * subscriber that attaches tomorrow is not told to sign in to a harness that
   * has been authenticated since. It rides the same delivery chain so it stays
   * ordered against the session updates around it. */
  private announceAuthRequired(): Promise<void> {
    const frame: AuthRequiredFrame = {
      jsonrpc: "2.0",
      method: "blitz/auth_required",
      params: { sessionId: this.id, provider: this.provider },
    };
    const operation = this.delivery.then(() => this.fanout(frame));
    this.delivery = operation.catch(() => undefined);
    return operation;
  }

  private async fanout(frame: OutboundFrame): Promise<void> {
    const subscribers = [...this.subscribers.values()];
    const settled = await Promise.allSettled(subscribers.map((subscriber) => subscriber.deliver(frame)));
    let index = 0;
    for (const subscriber of subscribers) {
      if (settled[index]?.status === "rejected") subscriber.close();
      index += 1;
    }
  }

  private requestPermission(
    request: RequestPermissionRequest,
    promptingIdentity: ConnectionIdentity,
  ): Promise<RequestPermissionResponse> {
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
    for (const subscriber of this.subscribers.values()) this.askSubscriber(permission, subscriber);
    const cancel = (): void => this.acceptPermission(
      permission,
      { outcome: { outcome: "cancelled" } },
      this.abortIdentity ?? promptingIdentity,
    );
    this.currentAbort?.signal.addEventListener("abort", cancel, { once: true });
    return permission.promise.finally(() => this.currentAbort?.signal.removeEventListener("abort", cancel));
  }

  private askSubscriber(permission: PendingPermission, subscriber: Subscriber): void {
    if (subscriber.identity.role === "viewer") return;
    if (permission.attempted.has(subscriber.id)) return;
    permission.attempted.add(subscriber.id);
    void subscriber.permission(permission.request).then(
      (response) => this.acceptPermission(permission, response, subscriber.identity),
      () => permission.attempted.delete(subscriber.id),
    );
  }

  private acceptPermission(
    permission: PendingPermission,
    response: RequestPermissionResponse,
    identity: ConnectionIdentity = { userId: "system", membershipId: "system", role: "owner" },
  ): void {
    if (!validPermissionAnswer(permission.request, response)) return;
    // First answer wins: the map delete is the idempotency gate the retired
    // permissions table row used to provide.
    if (!this.permissions.delete(permission.id)) return;
    const selected = response.outcome.outcome === "selected" ? response.outcome.optionId : null;
    const frame: PermissionAnsweredFrame = {
      jsonrpc: "2.0",
      method: "blitz/permission_answered",
      params: {
        sessionId: this.id,
        toolCallId: permission.request.toolCall.toolCallId,
        optionId: selected,
        actor: attributedActor(identity),
      },
    };
    this.store.append(this.id, frame);
    for (const subscriber of this.subscribers.values()) void subscriber.deliver(frame);
    permission.resolve(response);
  }
}

export class ActorService {
  private readonly sessions = new Map<string, SessionActor>();

  public constructor(
    private readonly store: ChatSessionStore,
    private readonly credentials: CredentialSource,
    private readonly adapters: AdapterFactory,
    private readonly defaultProvider: Provider,
    // Fired at session start so a running box can refresh its managed agent
    // rules without a reboot. Best-effort and non-blocking: createRulesRefresher
    // swallows its own failures, so this call needs no guard here. Defaults to a
    // no-op so tests and non-box callers need not wire it.
    private readonly onSessionStart: () => void = () => undefined,
  ) {}

  public async newSession(cwd: string, subscriber: Subscriber): Promise<string> {
    requireEditor(subscriber);
    this.onSessionStart();
    const id = randomUUID();
    this.store.createSession({
      id,
      provider: this.defaultProvider,
      cwd,
      resumeId: null,
      createdBy: subscriber.identity.userId,
      updatedAt: Date.now(),
    });
    const actor = this.restore(id);
    await actor.attach(subscriber, false);
    return id;
  }

  public async loadSession(id: string, cwd: string, subscriber: Subscriber): Promise<void> {
    const stored = this.store.session(id);
    if (!stored || stored.cwd !== cwd) throw new Error("unknown session");
    this.onSessionStart();
    await this.restore(id).attach(subscriber, true);
  }

  public listSessions(): ActorSessionSummary[] {
    return this.store.listSessions();
  }

  public configOptions(id: string): SessionConfigOption[] {
    return this.restore(id).configOptions();
  }

  public setConfigOption(id: string, configId: string, valueId: string, subscriber: Subscriber): SessionConfigOption[] {
    requireEditor(subscriber);
    return this.restore(id).setConfigOption(configId, valueId);
  }

  public prompt(id: string, prompt: ContentBlock[], subscriber: Subscriber): Promise<PromptResponse> {
    requireEditor(subscriber);
    return this.restore(id).enqueue(prompt, subscriber.identity);
  }

  public cancel(id: string, subscriber: Subscriber): void {
    requireEditor(subscriber);
    this.sessions.get(id)?.cancel(subscriber.identity);
  }

  public removeSubscriber(subscriber: Subscriber): void {
    for (const id of [...subscriber.sessions]) this.sessions.get(id)?.detach(subscriber);
  }

  private restore(id: string): SessionActor {
    const current = this.sessions.get(id);
    if (current) return current;
    const stored = this.store.session(id);
    if (!stored) throw new Error("unknown session");
    const actor = new SessionActor(
      stored.id,
      stored.provider,
      stored.cwd,
      stored.resumeId,
      this.adapters(stored.provider),
      this.store,
      this.credentials,
    );
    this.sessions.set(id, actor);
    return actor;
  }
}

function requireEditor(subscriber: Subscriber): void {
  if (subscriber.identity.role === "viewer") throw new Error("viewer access is replay-only");
}

function validPermissionAnswer(request: RequestPermissionRequest, response: RequestPermissionResponse): boolean {
  if (response.outcome.outcome === "cancelled") return true;
  const selected = response.outcome;
  return request.options.some(({ optionId }) => optionId === selected.optionId);
}
