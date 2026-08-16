import * as acp from "@agentclientprotocol/sdk";
import type {
  ClientContext,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
} from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { isString } from "../type-guards.js";
import { ChatTranscript } from "./ChatTranscript.js";
import { chatReducer, initialChatState } from "./reducer.js";

interface RawSessionNotification {
  sessionId: string;
  update: Record<string, unknown>;
}

const SHOW_THINKING_KEY = "blitz-chat-show-thinking";

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

export function ChatPanel({
  url,
  workspaceId,
  initialSessionId,
  onSessionId,
  onOpenPreview,
}: {
  url: string;
  workspaceId: string;
  initialSessionId: string | null;
  onSessionId: (workspaceId: string, sessionId: string) => void;
  onOpenPreview?: (port: number) => boolean;
}): React.JSX.Element {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [status, setStatus] = useState("Connecting…");
  const [composer, setComposer] = useState("");
  const [configOptions, setConfigOptions] = useState<SessionConfigOption[]>([]);
  const [showThinking, setShowThinking] = useState(
    () => localStorage.getItem(SHOW_THINKING_KEY) === "true",
  );
  const connectionRef = useRef<ClientContext | null>(null);
  const sessionIdRef = useRef<string | null>(initialSessionId);
  const onSessionIdRef = useRef(onSessionId);
  const runningRef = useRef(false);
  const turnRef = useRef(0);
  const permissionResolvers = useRef(new Map<string, Set<PermissionResolver>>());
  const permissionAnswers = useRef(new Map<string, RequestPermissionResponse>());
  onSessionIdRef.current = onSessionId;

  useEffect(() => {
    runningRef.current = state.running;
  }, [state.running]);

  const requestPermission = useCallback((request: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
    dispatch({ type: "permission-request", request });
    const id = request.toolCall.toolCallId;
    const answered = permissionAnswers.current.get(id);
    if (answered !== undefined) return Promise.resolve(answered);
    return new Promise((resolve) => {
      const resolvers = permissionResolvers.current.get(id) ?? new Set<PermissionResolver>();
      resolvers.add(resolve);
      permissionResolvers.current.set(id, resolvers);
    });
  }, []);

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
                dispatch({ type: "update", update: params.update });
              }
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
          const existingSession = sessionIdRef.current;
          if (existingSession === null) {
            const created = await context.request(acp.methods.agent.session.new, {
              cwd: "/workspace",
              mcpServers: [],
            });
            sessionIdRef.current = created.sessionId;
            onSessionIdRef.current(workspaceId, created.sessionId);
            setConfigOptions(created.configOptions ?? []);
          } else {
            dispatch({ type: "begin-replay" });
            const loaded = await context.request(acp.methods.agent.session.load, {
              sessionId: existingSession,
              cwd: "/workspace",
              mcpServers: [],
            });
            setConfigOptions(loaded.configOptions ?? []);
          }
          if (!active) break;
          attempts = 0;
          connectionRef.current = context;
          setStatus("Connected");
          await connection.closed;
        } catch {
          // A reconnect loads the session journal. Prompts are never resent.
        } finally {
          if (connectionRef.current === connection?.agent) connectionRef.current = null;
          connection.close();
        }
        if (!active) break;
        attempts += 1;
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
  }, [requestPermission, url, workspaceId]);

  const answerPermission = (toolCallId: string, optionId: string): void => {
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
  const [showJump, setShowJump] = useState(false);

  const updatePinned = (): void => {
    const element = scrollRef.current;
    if (!element) return;
    const pinned = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    pinnedRef.current = pinned;
    setShowJump(!pinned);
  };

  useEffect(() => {
    const element = scrollRef.current;
    if (element && pinnedRef.current) element.scrollTop = element.scrollHeight;
  }, [state]);

  const jumpToLatest = (): void => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
    pinnedRef.current = true;
    setShowJump(false);
  };

  const send = async (): Promise<void> => {
    const text = composer.trim();
    const context = connectionRef.current;
    const sessionId = sessionIdRef.current;
    if (text.length === 0 || context === null || sessionId === null || runningRef.current) return;
    const turnId = `turn-${++turnRef.current}`;
    runningRef.current = true;
    dispatch({ type: "turn-started", turnId });
    setComposer("");
    try {
      const result = await context.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text }],
      });
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

  const connected = status === "Connected";
  const selects = selectConfigs(configOptions);
  const model = selects.find((option) => option.id === "model");
  const runningModel = state.running && model !== undefined && model.currentValue !== "default"
    ? model.choices.find((choice) => choice.value === model.currentValue)?.name
    : undefined;
  return (
    <section className="panel chat-panel">
      <div className="chat-body">
        <div className="chat-scroll" ref={scrollRef} aria-live="polite" onScroll={updatePinned}>
          {state.rows.length === 0 && !state.running && (
            <div className="chat-empty">
              {connected
                ? "Ask the agent anything — it runs on your workspace VM."
                : status}
            </div>
          )}
          <ChatTranscript
            state={state}
            showThinking={showThinking}
            onPermission={answerPermission}
            onOpenPreview={onOpenPreview}
          />
          {state.running && (
            <div className="chat-working" role="status">
              <span className="webapp-inline-spinner" aria-hidden="true" />
              <span>Working…</span>
            </div>
          )}
          {!state.running && state.stopReasons.length > 0 && (
            <div className="chat-result-meta">{state.stopReasons.at(-1)?.stopReason}</div>
          )}
        </div>
        {showJump && (
          <button type="button" className="chat-jump" onClick={jumpToLatest}>
            Jump to latest
          </button>
        )}
      </div>
      <form
        className="chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <div className="chat-composer-controls">
          {selects.map((option) => (
            <label
              className={`chat-composer-control${option.id === "model" ? " chat-composer-control--model" : ""}`}
              key={option.id}
            >
              <span>{option.name}</span>
              <select
                className={option.id === "model" ? "chat-model-select" : undefined}
                aria-label={option.name}
                value={option.currentValue}
                disabled={!connected}
                onChange={(event) => void chooseConfig(option.id, event.currentTarget.value)}
              >
                {option.choices.map((choice) => (
                  <option key={choice.value} value={choice.value}>{choice.name}</option>
                ))}
              </select>
            </label>
          ))}
          <label className="chat-thinking-toggle">
            <input
              type="checkbox"
              aria-label="Show thinking"
              checked={showThinking}
              onChange={(event) => {
                setShowThinking(event.target.checked);
                localStorage.setItem(SHOW_THINKING_KEY, String(event.target.checked));
              }}
            />
            <span>Show thinking</span>
          </label>
          {runningModel && <span className="chat-active-model">Running: {runningModel}</span>}
        </div>
        <div className="chat-input-row">
          <textarea
            aria-label="Message"
            rows={1}
            value={composer}
            disabled={!connected}
            placeholder={connected ? "Message the agent…" : status}
            onChange={(event) => setComposer(event.currentTarget.value)}
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
              <button type="submit" disabled={!connected || composer.trim().length === 0}>
                Send
              </button>
            )}
          </div>
        </div>
      </form>
    </section>
  );
}

function parseSessionNotification(value: unknown): RawSessionNotification {
  if (!isRecord(value) || !isString(value.sessionId) || !isRecord(value.update)) {
    throw new Error("Malformed session update");
  }
  return { sessionId: value.sessionId, update: value.update };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
