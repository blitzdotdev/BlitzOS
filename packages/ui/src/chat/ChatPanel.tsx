import * as acp from "@agentclientprotocol/sdk";
import type {
  ClientContext,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionModeState,
} from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ChatTranscript } from "./ChatTranscript.js";
import { chatReducer, initialChatState } from "./reducer.js";

interface RawSessionNotification {
  sessionId: string;
  update: Record<string, unknown>;
}

type PermissionResolver = (response: RequestPermissionResponse) => void;

export function ChatPanel({
  url,
  workspaceId,
  initialSessionId,
  onSessionId,
}: {
  url: string;
  workspaceId: string;
  initialSessionId: string | null;
  onSessionId: (workspaceId: string, sessionId: string) => void;
}): React.JSX.Element {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [status, setStatus] = useState("Connecting…");
  const [composer, setComposer] = useState("");
  const [modes, setModes] = useState<SessionModeState | null>(null);
  const connectionRef = useRef<ClientContext | null>(null);
  const sessionIdRef = useRef<string | null>(initialSessionId);
  const runningRef = useRef(false);
  const turnRef = useRef(0);
  const permissionResolvers = useRef(new Map<string, Set<PermissionResolver>>());
  const permissionAnswers = useRef(new Map<string, RequestPermissionResponse>());

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
          .client({ name: "BlitzOS cockpit" })
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
            clientInfo: { name: "BlitzOS cockpit", version: "0.0.0" },
          });
          const existingSession = sessionIdRef.current;
          if (existingSession === null) {
            const created = await context.request(acp.methods.agent.session.new, {
              cwd: "/workspace",
              mcpServers: [],
            });
            sessionIdRef.current = created.sessionId;
            onSessionId(workspaceId, created.sessionId);
            setModes(created.modes ?? null);
          } else {
            dispatch({ type: "begin-replay" });
            const loaded = await context.request(acp.methods.agent.session.load, {
              sessionId: existingSession,
              cwd: "/workspace",
              mcpServers: [],
            });
            setModes(loaded.modes ?? null);
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
  }, [onSessionId, requestPermission, url, workspaceId]);

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

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
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

  const setMode = async (modeId: string): Promise<void> => {
    const sessionId = sessionIdRef.current;
    const context = connectionRef.current;
    if (sessionId === null || context === null || modes === null) return;
    await context.request(acp.methods.agent.session.setMode, { sessionId, modeId });
    setModes({ ...modes, currentModeId: modeId });
  };

  return (
    <section className="panel chat-panel">
      <div className="panel-toolbar">
        <span className="connection-status">{status}</span>
        {modes !== null && modes.availableModes.length > 0 && (
          <label>
            Mode
            <select value={modes.currentModeId} onChange={(event) => void setMode(event.currentTarget.value)}>
              {modes.availableModes.map((mode) => <option key={mode.id} value={mode.id}>{mode.name}</option>)}
            </select>
          </label>
        )}
      </div>
      <ChatTranscript state={state} onPermission={answerPermission} />
      {state.stopReasons.length > 0 && (
        <p className="stop-reason">Stopped: {state.stopReasons.at(-1)?.stopReason}</p>
      )}
      <form className="composer" onSubmit={(event) => void submit(event)}>
        <textarea
          aria-label="Message"
          rows={3}
          value={composer}
          disabled={state.running}
          placeholder={state.running ? "Agent is working…" : "Ask the agent"}
          onChange={(event) => setComposer(event.currentTarget.value)}
        />
        <div className="button-row">
          {state.running && <button type="button" onClick={cancel}>Cancel turn</button>}
          <button className="primary" type="submit" disabled={state.running || status !== "Connected"}>Send</button>
        </div>
      </form>
    </section>
  );
}

function parseSessionNotification(value: unknown): RawSessionNotification {
  if (!isRecord(value) || typeof value.sessionId !== "string" || !isRecord(value.update)) {
    throw new Error("Malformed session update");
  }
  return { sessionId: value.sessionId, update: value.update };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
