import * as acp from "@agentclientprotocol/sdk";
import type {
  ClientContext,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
} from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { HARNESSES, type AuthRequiredParams, type AuthRequiredProvider } from "@blitzos/schema";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { isString } from "../type-guards.js";
import type { Agent } from "../protocol.js";
import { SPAWN_SESSION_LABELS } from "../WebAppHeader.js";
import { ArrowIcon, WorkspaceIcon } from "../WebAppIcons.js";
import { WebAppSelectMenu } from "../WebAppSelectMenu.js";
import { ChatItemView, ChatTurnView, WorkingIndicator } from "./chat-turn-views.js";
import { textFromContent } from "./chat-render.js";
import { deriveChatTranscript } from "./chat-turns.js";
import { deriveChatItems } from "./chat-items.js";
import { chatReducer, initialChatState } from "./reducer.js";
import type { ChatActor, ChatPermission } from "./reducer.js";

interface RawSessionNotification {
  sessionId: string;
  update: Record<string, unknown>;
  actor?: ChatActor;
}

interface PermissionAnsweredNotification {
  sessionId: string;
  toolCallId: string;
  optionId: string | null;
  actor?: ChatActor;
}

const APPROVAL_PREVIEW_CHARS = 600;

/** The runtime half of {@link AuthRequiredProvider}, from the same list.
 *
 * `blitz/auth_required` arrives off a socket, so the name still has to be
 * checked at the boundary — but checking it against a re-spelled union would
 * let the panel drift from the broker feed that decides which harnesses can be
 * minted for at all.
 */
const HARNESS_NAMES: ReadonlySet<string> = new Set(HARNESSES);

type SelectConfig = {
  id: string;
  name: string;
  currentValue: string;
  choices: { value: string; name: string }[];
};

/** Keeps only the single-value selectors; grouped option lists are flattened. */
function selectConfigs(options: SessionConfigOption[]): SelectConfig[] {
  return options.flatMap((option) => {
    if (option.type !== "select") return [];
    const choices = option.options.flatMap((entry) =>
      "group" in entry ? entry.options : [entry],
    );
    return [{ id: option.id, name: option.name, currentValue: option.currentValue, choices }];
  });
}

type PermissionResolver = (response: RequestPermissionResponse) => void;

function approvalPayload<Value>(input: Value): string {
  if (input === undefined) return "";
  try {
    return JSON.stringify(input, null, 2) ?? "";
  } catch {
    return String(input);
  }
}

const MAX_RECONNECT_ATTEMPTS = 8;
export type ChatSessionIntent = "create" | "load" | "recover";

export function ChatPanel({
  url,
  workspaceId,
  initialSessionId,
  sessionIntent = initialSessionId === null ? "recover" : "load",
  boundSessionIds = [],
  onSessionId,
  onOpenPreview,
  onSignIn,
  readOnly = false,
}: {
  url: string;
  workspaceId: string;
  initialSessionId: string | null;
  /** New tabs create; stored ids load exactly; legacy id-less tabs recover. */
  sessionIntent?: ChatSessionIntent;
  /** Session ids already owned by other active or archived Chat tabs. */
  boundSessionIds?: readonly string[];
  onSessionId: (workspaceId: string, sessionId: string) => void;
  onOpenPreview?: (port: number) => boolean;
  /** Drives the harness's terminal tab into its login flow. */
  onSignIn?: (provider: Agent) => void;
  readOnly?: boolean;
}): React.JSX.Element {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [status, setStatus] = useState("Connecting…");
  const [draft, setDraft] = useState("");
  const [configOptions, setConfigOptions] = useState<SessionConfigOption[]>([]);
  const [authRequired, setAuthRequired] = useState<Agent | null>(null);
  const [approvalExpanded, setApprovalExpanded] = useState(false);
  const [turnStartedAt, setTurnStartedAt] = useState(Date.now());
  const [missingSessionId, setMissingSessionId] = useState<string | null>(null);
  const [connectionVersion, setConnectionVersion] = useState(0);
  const connectionRef = useRef<ClientContext | null>(null);
  const sessionIdRef = useRef<string | null>(initialSessionId);
  const sessionIntentRef = useRef<ChatSessionIntent>(sessionIntent);
  const recoverCanCreateRef = useRef(sessionIntent === "recover");
  const boundSessionIdsRef = useRef<ReadonlySet<string>>(new Set(boundSessionIds));
  const onSessionIdRef = useRef(onSessionId);
  const runningRef = useRef(false);
  const turnRef = useRef(0);
  const permissionResolvers = useRef(new Map<string, Set<PermissionResolver>>());
  const permissionAnswers = useRef(new Map<string, RequestPermissionResponse>());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  onSessionIdRef.current = onSessionId;
  boundSessionIdsRef.current = new Set(boundSessionIds);

  useEffect(() => {
    runningRef.current = state.running;
    if (state.running) setTurnStartedAt(Date.now());
  }, [state.running]);

  const requestPermission = useCallback((request: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
    if (readOnly) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    dispatch({ type: "permission-request", request });
    const id = request.toolCall.toolCallId;
    const answered = permissionAnswers.current.get(id);
    if (answered !== undefined) return Promise.resolve(answered);
    return new Promise((resolve) => {
      const resolvers = permissionResolvers.current.get(id) ?? new Set<PermissionResolver>();
      resolvers.add(resolve);
      permissionResolvers.current.set(id, resolvers);
    });
  }, [readOnly]);

  useEffect(() => {
    let active = true;
    let connection: acp.ClientConnection | null = null;
    let attempts = 0;
    let wake: (() => void) | null = null;

    const wait = (delay: number): Promise<void> => new Promise((resolve) => {
      const timer = setTimeout(resolve, delay);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

    const run = async (): Promise<void> => {
      while (active) {
        let haltAfterClose = false;
        setStatus(attempts === 0 ? "Connecting…" : "Reconnecting…");
        const stream = createWebSocketStream(url);
        const app = acp
          .client({ name: "BlitzOS webApp" })
          .onRequest(acp.methods.client.session.requestPermission, ({ params }) => requestPermission(params))
          .onNotification<RawSessionNotification>(
            acp.methods.client.session.update,
            parseSessionNotification,
            ({ params }) => {
              if (sessionIdRef.current === null || params.sessionId === sessionIdRef.current) {
                if (params.actor === undefined) dispatch({ type: "update", update: params.update });
                else dispatch({ type: "update", update: params.update, actor: params.actor });
              }
            },
          )
          .onNotification<PermissionAnsweredNotification>(
            "blitz/permission_answered",
            parsePermissionAnsweredNotification,
            ({ params }) => {
              if (sessionIdRef.current === params.sessionId) {
                const answer = {
                  type: "permission-answered" as const,
                  toolCallId: params.toolCallId,
                  optionId: params.optionId,
                  actor: params.actor,
                };
                if (params.actor === undefined) dispatch({ ...answer, actor: undefined });
                else dispatch(answer);
              }
            },
          )
          .onNotification<AuthRequiredParams>(
            "blitz/auth_required",
            parseAuthRequiredNotification,
            ({ params }) => {
              if (sessionIdRef.current === params.sessionId) setAuthRequired(params.provider);
            },
          );
        connection = app.connect(stream);
        try {
          const context = connection.agent;
          await context.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
            clientInfo: { name: "BlitzOS webapp", version: "0.0.0" },
          });
          let existingSession = sessionIdRef.current;
          if (existingSession === null && sessionIntentRef.current === "recover") {
            try {
              const listed = await context.request(acp.methods.agent.session.list, { cwd: "/workspace" });
              existingSession = listed.sessions.find(
                (session) => !boundSessionIdsRef.current.has(session.sessionId),
              )?.sessionId ?? null;
            } catch {
              // Compatibility window: an already-pinned actor may predate session/list.
            }
            if (existingSession !== null) {
              sessionIdRef.current = existingSession;
              onSessionIdRef.current(workspaceId, existingSession);
            }
          }
          const mayCreate = sessionIntentRef.current === "create"
            || (sessionIntentRef.current === "recover" && recoverCanCreateRef.current);
          if (existingSession === null && !readOnly && mayCreate) {
            const created = await context.request(acp.methods.agent.session.new, {
              cwd: "/workspace",
              mcpServers: [],
            });
            sessionIdRef.current = created.sessionId;
            sessionIntentRef.current = "load";
            onSessionIdRef.current(workspaceId, created.sessionId);
            setConfigOptions(created.configOptions ?? []);
          } else if (existingSession !== null) {
            dispatch({ type: "begin-replay" });
            try {
              const loaded = await context.request(acp.methods.agent.session.load, {
                sessionId: existingSession,
                cwd: "/workspace",
                mcpServers: [],
              });
              sessionIntentRef.current = "load";
              dispatch({ type: "reconcile-running" });
              runningRef.current = false;
              setConfigOptions(loaded.configOptions ?? []);
            } catch {
              setMissingSessionId(existingSession);
              setStatus("Stored chat session is unavailable");
              haltAfterClose = true;
            }
          } else {
            setMissingSessionId((current) => current ?? "unavailable");
            setStatus("No chat session is available to replay");
            haltAfterClose = true;
          }
          if (haltAfterClose) throw new Error("chat session selection required");
          if (!active) break;
          attempts = 0;
          connectionRef.current = context;
          setStatus(readOnly ? "Connected · replay only" : "Connected");
          await connection.closed;
        } catch {
          // A reconnect loads the session journal. Prompts are never resent.
        } finally {
          if (connectionRef.current === connection?.agent) connectionRef.current = null;
          connection.close();
        }
        if (!active) break;
        if (haltAfterClose) break;
        attempts += 1;
        // A refused handshake — no access to this workspace, or a box that is
        // gone — never resolves by retrying, and the capped backoff would
        // knock every ten seconds for as long as the tab stays open. Give up
        // and let the reader retry deliberately.
        if (attempts >= MAX_RECONNECT_ATTEMPTS) {
          setStatus("Disconnected · reload to reconnect");
          break;
        }
        setStatus("Disconnected");
        await wait(Math.min(500 * 2 ** (attempts - 1), 10_000));
        wake = null;
      }
    };

    void run();
    return () => {
      active = false;
      wake?.();
      connection?.close();
      connectionRef.current = null;
    };
  }, [connectionVersion, readOnly, requestPermission, url, workspaceId]);

  const chooseSessionRecovery = (intent: "create" | "recover"): void => {
    sessionIdRef.current = null;
    sessionIntentRef.current = intent;
    recoverCanCreateRef.current = false;
    setMissingSessionId(null);
    setStatus("Connecting…");
    setConnectionVersion((version) => version + 1);
  };

  const answerPermission = (toolCallId: string, optionId: string): void => {
    if (readOnly) return;
    if (permissionAnswers.current.has(toolCallId)) return;
    const response: RequestPermissionResponse = {
      outcome: { outcome: "selected", optionId },
    };
    permissionAnswers.current.set(toolCallId, response);
    dispatch({ type: "permission-answered", toolCallId, optionId });
    for (const resolve of permissionResolvers.current.get(toolCallId) ?? []) resolve(response);
    permissionResolvers.current.delete(toolCallId);
  };

  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);

  const updatePinned = (): void => {
    const element = scrollRef.current;
    if (!element) return;
    const next = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    pinnedRef.current = next;
    setPinned(next);
  };

  useEffect(() => {
    const element = scrollRef.current;
    if (element && pinnedRef.current) element.scrollTop = element.scrollHeight;
  }, [state]);

  const jumpToLatest = (): void => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
    pinnedRef.current = true;
    setPinned(true);
  };

  const send = async (): Promise<void> => {
    const text = draft.trim();
    const context = connectionRef.current;
    const sessionId = sessionIdRef.current;
    if (text.length === 0 || context === null || sessionId === null || runningRef.current) return;
    const turnId = `turn-${++turnRef.current}`;
    runningRef.current = true;
    setTurnStartedAt(Date.now());
    dispatch({ type: "turn-started", turnId });
    setDraft("");
    try {
      const result = await context.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text }],
      });
      // A turn the box refused is the turn that raised the sign-in prompt; any
      // other ending proves the credential works again, so the prompt goes.
      if (result.stopReason !== "refusal") setAuthRequired(null);
      dispatch({ type: "turn-ended", turnId, stopReason: result.stopReason });
    } catch {
      dispatch({ type: "generic", label: "The connection closed; the prompt was not resent." });
    }
  };

  const cancel = (): void => {
    const sessionId = sessionIdRef.current;
    if (sessionId !== null) {
      void connectionRef.current?.notify(acp.methods.agent.session.cancel, { sessionId });
    }
  };

  const chooseConfig = async (configId: string, value: string): Promise<void> => {
    const sessionId = sessionIdRef.current;
    const context = connectionRef.current;
    if (sessionId === null || context === null) return;
    const answer = await context.request(acp.methods.agent.session.setConfigOption, {
      sessionId,
      configId,
      value,
    });
    setConfigOptions(answer.configOptions ?? []);
  };

  const connected = status.startsWith("Connected");
  const connectionTone = connected
    ? "connected"
    : status === "Disconnected" ? "disconnected" : "connecting";
  const selects = selectConfigs(configOptions);
  const model = selects.find((option) => option.id === "model");
  const runningModel = state.running && model !== undefined && model.currentValue !== "default"
    ? model.choices.find((choice) => choice.value === model.currentValue)?.name
    : undefined;
  const derived = useMemo(() => deriveChatItems(state), [state]);
  const transcript = useMemo(
    () => deriveChatTranscript(derived.items, derived.toolResults),
    [derived],
  );
  // Viewers cannot prompt, so they are never the ones who have to sign in.
  const signInProvider = readOnly || onSignIn === undefined ? null : authRequired;
  const approval: ChatPermission | null = readOnly ? null : derived.activePermission;
  const approvalText = approval === null
    ? ""
    : approvalPayload(approval.rawInput ?? textFromContent(approval.rawInput));
  const approvalTruncated = approvalText.length > APPROVAL_PREVIEW_CHARS;
  const workingDirectory = "/workspace";

  return (
    <div className="chat-panel">
      <div className="chat-body">
        <div className="chat-scroll" ref={scrollRef} aria-live="polite" onScroll={updatePinned}>
          <div className="chat-transcript">
            {derived.items.length === 0 && !state.running && (
              <div className="chat-empty">
                <WorkspaceIcon />
                <strong>Chat</strong>
                <p>
                  {connected
                    ? "Start a conversation with the agent on this workspace."
                    : status}
                </p>
              </div>
            )}
            {transcript.map((entry) => entry.kind === "turn" ? (
              <ChatTurnView
                key={`turn:${entry.turn.id}`}
                turn={entry.turn}
                toolResults={derived.toolResults}
                showThinking
                onOpenPreview={onOpenPreview}
                workingDirectory={workingDirectory}
              />
            ) : (
              <ChatItemView
                key={`loose:${entry.item.id}`}
                item={entry.item}
                toolResults={derived.toolResults}
                showThinking
                onOpenPreview={onOpenPreview}
                workingDirectory={workingDirectory}
              />
            ))}
            {state.running && <WorkingIndicator startedAt={turnStartedAt} />}
          </div>
        </div>
        <button
          type="button"
          className={`chat-jump${pinned ? "" : " is-visible"}`}
          aria-label="Jump to latest"
          aria-hidden={pinned}
          disabled={pinned}
          tabIndex={pinned ? -1 : 0}
          onClick={jumpToLatest}
        ><ArrowIcon direction="down" /></button>
      </div>

      <div className="chat-dock">
        {missingSessionId !== null && (
          <div className="chat-session-recovery" role="alert">
            <div>
              <strong>This Chat's saved session could not be loaded.</strong>
              <span>Choose whether to recover another unbound session or start a new conversation.</span>
            </div>
            <div className="chat-session-recovery-actions">
              <button type="button" onClick={() => chooseSessionRecovery("recover")}>
                Recover existing
              </button>
              {!readOnly && (
                <button type="button" onClick={() => chooseSessionRecovery("create")}>
                  Start new chat
                </button>
              )}
            </div>
          </div>
        )}
        {signInProvider !== null && (
          <div className="chat-auth-required" role="status">
            <span>{SPAWN_SESSION_LABELS[signInProvider]} could not authenticate on this workspace.</span>
            <button
              type="button"
              className="chat-auth-required-action"
              onClick={() => onSignIn?.(signInProvider)}
            >
              Sign in to {SPAWN_SESSION_LABELS[signInProvider]}
            </button>
          </div>
        )}

        {approval !== null && (
          <div className="chat-approval" role="alertdialog" aria-label="Tool approval">
            <div className="chat-approval-title">Allow {approval.title}?</div>
            {approvalText !== "" && (
              <pre className={`chat-approval-input${approvalExpanded ? " chat-approval-input--full" : ""}`}>
                {approvalTruncated && !approvalExpanded
                  ? `${approvalText.slice(0, APPROVAL_PREVIEW_CHARS)}…`
                  : approvalText}
              </pre>
            )}
            {approvalTruncated && (
              <button
                type="button"
                className="chat-approval-expand"
                onClick={() => setApprovalExpanded((current) => !current)}
              >
                {approvalExpanded ? "Show less" : "Show full payload"}
              </button>
            )}
            <div className="chat-approval-actions">
              {approval.options.map((option) => (
                <button
                  type="button"
                  key={option.optionId}
                  className={option.kind.startsWith("reject") ? "chat-approval-deny" : undefined}
                  onClick={() => answerPermission(approval.toolCallId, option.optionId)}
                >
                  {option.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {readOnly ? (
          <div className="chat-composer chat-composer--readonly" role="status">
            Replay only · viewers can follow this session but cannot prompt, cancel, or answer permissions.
          </div>
        ) : (
          <div className="chat-composer">
            <div className="chat-composer-context">
              <span className={`chat-link-state chat-link-state--${connectionTone}`} aria-hidden="true" />
              <strong>{status}</strong>
              <span>·</span>
              <span>{workingDirectory}</span>
            </div>
            <div className="chat-input-row">
              <span className="chat-input-prompt" aria-hidden="true">❯</span>
              <textarea
                ref={textareaRef}
                aria-label="Message"
                rows={1}
                value={draft}
                disabled={!connected}
                placeholder={connected ? "message the agent…" : "Connecting…"}
                onChange={(event) => setDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && state.running) {
                    event.preventDefault();
                    cancel();
                  } else if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="chat-input-actions">
                {state.running ? (
                  <button type="button" className="chat-stop" onClick={cancel}>
                    <span className="chat-key">Esc</span> Stop
                  </button>
                ) : (
                  <button
                    type="button"
                    className="chat-send"
                    aria-label="Send message"
                    onClick={() => { void send(); }}
                    disabled={!connected || draft.trim().length === 0}
                  ><ArrowIcon direction="up" /></button>
                )}
              </div>
            </div>
            <div className="chat-composer-controls">
              {selects.map((option, index) => (
                <span key={option.id} style={{ display: "contents" }}>
                  {index > 0 && <span aria-hidden="true">·</span>}
                  <WebAppSelectMenu
                    className={`chat-composer-control${option.id === "model" ? " chat-composer-control--model" : ""}`}
                    ariaLabel={option.name}
                    value={option.currentValue}
                    options={option.choices.map((choice) => ({ value: choice.value, label: choice.name }))}
                    onChange={(value) => { void chooseConfig(option.id, value); }}
                    disabled={!connected}
                  />
                </span>
              ))}
              {runningModel && <span className="chat-active-model">running {runningModel}</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function parseSessionNotification<Value>(value: Value): RawSessionNotification {
  if (!isRecord(value) || !isString(value.sessionId) || !isRecord(value.update)) {
    throw new Error("Malformed session update");
  }
  const actor = parseActor(value.actor);
  const notification: RawSessionNotification = { sessionId: value.sessionId, update: value.update };
  if (actor !== undefined) notification.actor = actor;
  return notification;
}

function parsePermissionAnsweredNotification<Value>(value: Value): PermissionAnsweredNotification {
  if (
    !isRecord(value)
    || !isString(value.sessionId)
    || !isString(value.toolCallId)
    || !(value.optionId === null || isString(value.optionId))
  ) throw new Error("Malformed permission answer");
  const actor = parseActor(value.actor);
  const notification: PermissionAnsweredNotification = {
    sessionId: value.sessionId,
    toolCallId: value.toolCallId,
    optionId: value.optionId,
  };
  if (actor !== undefined) notification.actor = actor;
  return notification;
}

function parseAuthRequiredNotification<Value>(value: Value): AuthRequiredParams {
  if (!isRecord(value) || !isString(value.sessionId) || !isHarnessName(value.provider)) {
    throw new Error("Malformed auth requirement");
  }
  return { sessionId: value.sessionId, provider: value.provider };
}

function isHarnessName<Value>(value: Value): value is Value & AuthRequiredProvider {
  return isString(value) && HARNESS_NAMES.has(value);
}

function parseActor<Value>(value: Value): ChatActor | undefined {
  if (!isRecord(value) || !isString(value.userId)) return undefined;
  if (!(value.name === undefined || isString(value.name))) return undefined;
  const actor: ChatActor = { userId: value.userId };
  if (isString(value.name)) actor.name = value.name;
  return actor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
