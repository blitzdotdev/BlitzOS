import type { MachineType, Volume, WorkspaceView } from "@blitzos/schema";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiRequestError, type ControlPlaneClient } from "./api.js";
import { ChatPanel } from "./chat/ChatPanel.js";
import { CreateWorkspaceForm } from "./components/CreateWorkspaceForm.js";
import { ErrorState } from "./components/RetryActionButton.js";
import { LoginForm } from "./components/LoginForm.js";
import { PreviewPanel } from "./components/PreviewPanel.js";
import { SettingsPanel } from "./components/SettingsPanel.js";
import { TtydTerminal } from "./components/TtydTerminal.js";
import { useWorkspaceTab, type CockpitTab } from "./device-state.js";
import { FilesPanel } from "./files/FilesPanel.js";
import type { EndpointResolver, StandalonePorts } from "./resolver.js";
import "./styles.css";
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

const TABS: CockpitTab[] = ["terminal", "chat", "files", "preview"];

export function Cockpit({ client, resolver, standaloneSettings }: CockpitProps): React.JSX.Element {
  const [auth, setAuth] = useState<AuthState>("checking");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
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
  const selected = polling.workspaces.find(({ id }) => id === selectedId) ?? null;
  const [tab, setTab] = useWorkspaceTab(selected?.id ?? null);

  useEffect(() => {
    if (selected !== null) return;
    setSelectedId(polling.workspaces[0]?.id ?? null);
  }, [polling.workspaces, selected]);

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

  return (
    <div className="cockpit">
      <aside className="workspace-rail">
        <div className="brand">BlitzOS</div>
        <button className="primary create-button" type="button" onClick={() => setShowCreate(true)}>+ Workspace</button>
        <nav aria-label="Workspaces">
          {polling.workspaces.map((workspace) => (
            <button
              type="button"
              key={workspace.id}
              className={workspace.id === selectedId ? "workspace-button selected" : "workspace-button"}
              onClick={() => setSelectedId(workspace.id)}
            >
              <span>{workspace.id.slice(0, 8)}</span>
              <span className={`phase-badge ${workspace.phase}`}>{workspace.phase}</span>
            </button>
          ))}
        </nav>
      </aside>
      <main className="cockpit-main">
        <header className="cockpit-header">
          <div>
            <p className="eyebrow">Open cockpit</p>
            <h1>{selected === null ? "Workspaces" : selected.id}</h1>
          </div>
          <div className="button-row">
            {standaloneSettings !== undefined && <button type="button" onClick={() => setShowSettings(true)}>Tunnel settings</button>}
            <button type="button" onClick={() => void logout()}>Logout</button>
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
            {createOptionsError !== null && <p className="form-error">{createOptionsError}</p>}
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
          <div className="empty-state card"><h2>No workspaces</h2><p>Create one to open the cockpit.</p></div>
        )}

        {!showCreate && selected !== null && endpoints !== null && (
          <section className="workspace-view">
            <div className="workspace-summary">
              <span className={`phase-badge ${selected.phase}`}>{selected.phase}</span>
              {selected.ssh !== null && (
                <code>{selected.ssh.user}@{selected.ssh.host}:{selected.ssh.port}</code>
              )}
              {selected.retryAction !== null && (
                <button type="button" data-retry-action={selected.retryAction} onClick={() => retry(selected, selected.retryAction!)}>Retry</button>
              )}
              {selected.phase !== "destroyed" && selected.phase !== "destroying" && (
                <button className="danger" type="button" onClick={() => setDestroyId(selected.id)}>Destroy</button>
              )}
            </div>
            {selected.error !== null && <p className="workspace-error" role="alert">{selected.error}</p>}
            <div className="tabs" role="tablist" aria-label="Workspace tools">
              {TABS.map((candidate) => {
                const enabled = candidate === "terminal" ? selected.canObserve : selected.launchable;
                return (
                  <button
                    role="tab"
                    type="button"
                    key={candidate}
                    aria-selected={tab === candidate}
                    disabled={!enabled}
                    onClick={() => selectTab(selected, candidate)}
                  >
                    {candidate[0]?.toUpperCase()}{candidate.slice(1)}
                  </button>
                );
              })}
            </div>
            {tab === "terminal" && selected.canObserve && <TtydTerminal url={endpoints.terminalUrl} readOnly={!selected.launchable} />}
            {tab === "files" && selected.launchable && <FilesPanel baseUrl={endpoints.filesBase} />}
            {tab === "preview" && selected.launchable && <PreviewPanel workspace={selected} resolver={resolver} />}
            {((tab === "terminal" && !selected.canObserve) || (tab !== "terminal" && !selected.launchable)) && (
              <div className="empty-state card">This surface is unavailable in the current server view.</div>
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
              <button type="button" onClick={() => setDestroyId(null)}>Cancel</button>
              <button className="danger" type="button" onClick={() => void destroy()}>Destroy</button>
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
    </div>
  );
}
