import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import type { MachineType, Volume, WorkspaceView } from "@blitzos/schema";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiRequestError, type ControlPlaneClient } from "./api.js";
import { ChatPanel } from "./chat/ChatPanel.js";
import { CreateWorkspaceForm } from "./components/CreateWorkspaceForm.js";
import { ErrorState } from "./components/RetryActionButton.js";
import { LoginForm } from "./components/LoginForm.js";
import { LeasesPanel } from "./components/LeasesPanel.js";
import { PreviewPanel } from "./components/PreviewPanel.js";
import { SettingsPanel } from "./components/SettingsPanel.js";
import { TtydTerminal } from "./components/TtydTerminal.js";
import { useWorkspaceTab, type CockpitTab } from "./device-state.js";
import { FilesPanel } from "./files/FilesPanel.js";
import { IntegrationsPanel } from "./settings/IntegrationsPanel.js";
import { endpointTarget, type EndpointResolver, type StandalonePorts } from "./resolver.js";
import { useWorkspaces } from "./use-workspaces.js";

export interface CockpitProps {
  client: ControlPlaneClient;
  resolver: EndpointResolver;
  standaloneSettings?: {
    ports: StandalonePorts;
    onSave: (ports: StandalonePorts) => void;
  };
}

type AuthState = "checking" | "authenticated" | "signed-out";

const TABS: CockpitTab[] = ["terminal", "chat", "files", "preview", "leases"];

export function Cockpit({ client, resolver, standaloneSettings }: CockpitProps): React.JSX.Element {
  const [auth, setAuth] = useState<AuthState>("checking");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showDestroyed, setShowDestroyed] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showCredentials, setShowCredentials] = useState(false);
  const [destroyId, setDestroyId] = useState<string | null>(null);
  const [machineTypes, setMachineTypes] = useState<MachineType[]>([]);
  const [volumes, setVolumes] = useState<Volume[]>([]);
  const [createOptionsLoading, setCreateOptionsLoading] = useState(false);
  const [createOptionsError, setCreateOptionsError] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<ApiRequestError | null>(null);
  const [openedChats, setOpenedChats] = useState<Set<string>>(() => new Set());
  const destroyingRef = useRef(false);
  const chatSessionsRef = useRef(new Map<string, string>());
  const authenticated = useCallback(() => setAuth("authenticated"), []);
  const signedOut = useCallback(() => setAuth("signed-out"), []);
  const rememberChatSession = useCallback((workspaceId: string, sessionId: string) => {
    chatSessionsRef.current.set(workspaceId, sessionId);
  }, []);
  const polling = useWorkspaces(client, auth !== "signed-out", authenticated, signedOut);
  const destroyedCount = polling.workspaces.filter(({ phase }) => phase === "destroyed").length;
  const railWorkspaces = showDestroyed
    ? polling.workspaces
    : polling.workspaces.filter(({ phase }) => phase !== "destroyed");
  const selected = railWorkspaces.find(({ id }) => id === selectedId) ?? null;
  const [tab, setTab] = useWorkspaceTab(selected?.id ?? null);

  useEffect(() => {
    if (selected === null || tab !== "chat" || !selected.launchable) return;
    setOpenedChats((current) => {
      if (current.has(selected.id)) return current;
      const next = new Set(current);
      next.add(selected.id);
      return next;
    });
  }, [selected, tab]);

  useEffect(() => {
    if (!showCreate) return;
    let active = true;
    setCreateOptionsLoading(true);
    setCreateOptionsError(null);
    void Promise.all([client.listMachineTypes(), client.listVolumes()]).then(
      ([machines, listedVolumes]) => {
        if (!active) return;
        setMachineTypes(machines.machineTypes);
        setVolumes(listedVolumes.volumes);
        setCreateOptionsLoading(false);
      },
      (caught: unknown) => {
        if (!active) return;
        setCreateOptionsError(caught instanceof Error ? caught.message : "Create options failed to load.");
        setCreateOptionsLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [client, showCreate]);

  const login = async (operatorKey: string): Promise<void> => {
    await client.login(operatorKey);
    setAuth("checking");
  };

  const logout = async (): Promise<void> => {
    try {
      await client.logout();
    } finally {
      setAuth("signed-out");
    }
  };

  const create = async (request: Parameters<ControlPlaneClient["create"]>[0]): Promise<void> => {
    try {
      const response = await client.create(request);
      polling.accept(response.workspace);
      setSelectedId(response.workspace.id);
      setShowCreate(false);
      setOperationError(null);
    } catch (caught) {
      if (caught instanceof ApiRequestError) setOperationError(caught);
      throw caught;
    }
  };

  const destroy = async (): Promise<void> => {
    if (destroyId === null || destroyingRef.current) return;
    destroyingRef.current = true;
    const id = destroyId;
    setDestroyId(null);
    try {
      const response = await client.destroy(id);
      polling.accept(response.workspace);
      setOperationError(null);
    } catch (caught) {
      if (caught instanceof ApiRequestError) setOperationError(caught);
    } finally {
      destroyingRef.current = false;
    }
  };

  const retry = (workspace: WorkspaceView | null, action: "poll" | "destroy" | "create"): void => {
    if (action === "poll") polling.pollNow();
    else if (action === "destroy" && workspace !== null) setDestroyId(workspace.id);
    else if (action === "create") setShowCreate(true);
  };

  const selectTab = (workspace: WorkspaceView, next: CockpitTab): void => {
    if (next === "chat") {
      setOpenedChats((current) => {
        const opened = new Set(current);
        opened.add(workspace.id);
        return opened;
      });
    }
    setTab(next);
  };

  if (auth === "signed-out") return <LoginForm onLogin={login} />;
  if (auth === "checking" || (polling.loading && polling.workspaces.length === 0)) {
    return <main className="center-state"><p className="loading-state">Loading cockpit…</p></main>;
  }

  const endpoints = selected === null ? null : resolver.resolve(selected);
  const tabTargets = selected === null || endpoints === null ? null : {
    terminal: endpointTarget(endpoints.terminalUrl),
    chat: endpointTarget(endpoints.acpUrl),
    files: endpointTarget(endpoints.filesBase),
    preview: endpointTarget(resolver.previewUrl(selected, 3000)),
    leases: "Control plane",
  } satisfies Record<CockpitTab, string>;

  return (
    <div className="cockpit">
      <aside className="workspace-rail">
        <div className="brand">BlitzOS</div>
        <button className="cockpit-action cockpit-action--primary create-button" type="button" onClick={() => setShowCreate(true)}>+ Workspace</button>
        <nav aria-label="Workspaces">
          {railWorkspaces.length === 0 && <p className="rail-empty">No workspaces yet</p>}
          {railWorkspaces.map((workspace) => (
            <button
              type="button"
              key={workspace.id}
              className={workspace.id === selectedId ? "cockpit-action workspace-button selected" : "cockpit-action workspace-button"}
              onClick={() => setSelectedId(workspace.id)}
            >
              <span>{workspace.id.slice(0, 8)}</span>
              <span className={`phase-badge ${workspace.phase}`}>{workspace.phase}</span>
            </button>
          ))}
        </nav>
        {destroyedCount > 0 && (
          <button className="cockpit-action destroyed-toggle" type="button" onClick={() => setShowDestroyed((current) => !current)}>
            {showDestroyed ? "Hide destroyed" : `Show destroyed (${destroyedCount})`}
          </button>
        )}
      </aside>
      <main className="cockpit-main">
        <header className="cockpit-header">
          <div>
            <p className="eyebrow">Open cockpit</p>
            <h1>{selected === null ? "Not connected" : selected.id}</h1>
          </div>
          <div className="button-row">
            <button className="cockpit-action" type="button" onClick={() => setShowCredentials(true)}>Credentials</button>
            {standaloneSettings !== undefined && <button className="cockpit-action" type="button" onClick={() => setShowSettings(true)}>Tunnel settings</button>}
            <button className="cockpit-action" type="button" onClick={() => void logout()}>Logout</button>
          </div>
        </header>

        {polling.error !== null && (
          <ErrorState error={polling.error.error} retryAction={polling.error.retryAction} onRetry={(action) => retry(selected, action)} />
        )}
        {operationError !== null && (
          <ErrorState error={operationError.message} retryAction={operationError.retryAction} onRetry={(action) => retry(selected, action)} />
        )}

        {showCreate && (
          <>
            {createOptionsError !== null && <p className="cockpit-form-message form-error">{createOptionsError}</p>}
            <CreateWorkspaceForm
              machineTypes={machineTypes}
              volumes={volumes}
              loading={createOptionsLoading}
              onCreate={create}
              onCancel={() => setShowCreate(false)}
            />
          </>
        )}

        {!showCreate && selected === null && (
          <div className="cockpit-empty" data-connection-state="not-connected">
            <svg viewBox="0 0 32 32" aria-hidden="true">
              <path d="M6.5 9.5 16 4l9.5 5.5v11L16 26l-9.5-5.5z" />
              <path d="m6.5 9.5 9.5 5.5 9.5-5.5M16 15v11" />
            </svg>
            <h1>Not connected</h1>
            <p>{railWorkspaces.length === 0 ? "Create a workspace to connect." : "Select a workspace to connect."}</p>
            {railWorkspaces.length === 0 && (
              <button className="cockpit-action cockpit-action--primary" type="button" onClick={() => setShowCreate(true)}>Create workspace</button>
            )}
          </div>
        )}

        {!showCreate && selected !== null && endpoints !== null && (
          <section className="workspace-view">
            <div className="workspace-summary">
              <span className={`phase-badge ${selected.phase}`}>{selected.phase}</span>
              {selected.ssh !== null && (
                <code>{selected.ssh.user}@{selected.ssh.host}:{selected.ssh.port}</code>
              )}
              {selected.retryAction !== null && (
                <button className="cockpit-action" type="button" data-retry-action={selected.retryAction} onClick={() => retry(selected, selected.retryAction!)}>Retry</button>
              )}
              {selected.phase !== "destroyed" && selected.phase !== "destroying" && (
                <button className="cockpit-action danger" type="button" onClick={() => setDestroyId(selected.id)}>Destroy</button>
              )}
            </div>
            {selected.error !== null && <p className="workspace-error" role="alert">{selected.error}</p>}
            <div className="tabs" role="tablist" aria-label="Workspace tools">
              {TABS.map((candidate) => {
                const enabled = candidate === "leases"
                  ? true
                  : candidate === "terminal"
                    ? selected.canObserve
                    : selected.launchable;
                return (
                  <button
                    className="cockpit-action"
                    role="tab"
                    type="button"
                    key={candidate}
                    aria-selected={tab === candidate}
                    disabled={!enabled}
                    onClick={() => selectTab(selected, candidate)}
                  >
                    <span>{candidate[0]?.toUpperCase()}{candidate.slice(1)}</span>
                    <small>{tabTargets?.[candidate]}</small>
                  </button>
                );
              })}
            </div>
            {tab === "terminal" && selected.canObserve && <TtydTerminal url={endpoints.terminalUrl} readOnly={!selected.launchable} />}
            {tab === "files" && selected.launchable && <FilesPanel baseUrl={endpoints.filesBase} />}
            {tab === "preview" && selected.launchable && <PreviewPanel workspace={selected} resolver={resolver} />}
            {tab === "leases" && <LeasesPanel client={client} workspaceId={selected.id} />}
            {((tab === "terminal" && !selected.canObserve) ||
              (tab !== "terminal" && tab !== "leases" && !selected.launchable)) && (
              <div className="cockpit-empty">
                <svg viewBox="0 0 32 32" aria-hidden="true">
                  <rect x="5" y="7" width="22" height="18" />
                  <path d="M10 12h12M10 16h8" />
                </svg>
                <h1>Surface unavailable</h1>
                <p>This surface is unavailable in the current server view.</p>
              </div>
            )}
          </section>
        )}
        {polling.workspaces
          .filter((workspace) => openedChats.has(workspace.id) && workspace.launchable)
          .map((workspace) => (
            <div
              className="persistent-chat"
              key={workspace.id}
              hidden={showCreate || selected?.id !== workspace.id || tab !== "chat"}
            >
              <ChatPanel
                url={resolver.resolve(workspace).acpUrl}
                workspaceId={workspace.id}
                initialSessionId={chatSessionsRef.current.get(workspace.id) ?? null}
                onSessionId={rememberChatSession}
              />
            </div>
          ))}
      </main>

      {destroyId !== null && (
        <div className="modal-backdrop" role="presentation">
          <div className="card modal" role="dialog" aria-modal="true" aria-label="Confirm workspace destroy">
            <h2>Destroy workspace?</h2>
            <p>This destroys {destroyId}. An attached volume is preserved.</p>
            <div className="button-row">
              <button className="cockpit-action" type="button" onClick={() => setDestroyId(null)}>Cancel</button>
              <button className="cockpit-action danger" type="button" onClick={() => void destroy()}>Destroy</button>
            </div>
          </div>
        </div>
      )}
      {showSettings && standaloneSettings !== undefined && (
        <SettingsPanel
          ports={standaloneSettings.ports}
          onSave={standaloneSettings.onSave}
          onClose={() => setShowSettings(false)}
        />
      )}
      {showCredentials && (
        <IntegrationsPanel client={client} onClose={() => setShowCredentials(false)} />
      )}
    </div>
  );
}
