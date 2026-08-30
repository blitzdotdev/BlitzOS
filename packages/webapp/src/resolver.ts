import type { WorkspaceView } from "@blitzos/schema";

export interface BoxEndpoints {
  terminalUrl: string;
  filesBase: string;
  /** WebSocket carrying the Lody session daemon's CRDT data plane. */
  lodySyncUrl: string;
  /** HTTP endpoint for the Lody daemon's machine RPC. */
  lodyRpcUrl: string;
}

export interface EndpointResolver {
  resolve(workspace: WorkspaceView): BoxEndpoints;
  previewUrl(workspace: WorkspaceView, port: number): string;
}

export interface StandalonePorts {
  files: number;
}

export const DEFAULT_PORTS: StandalonePorts = { files: 7445 };

/** The guest's dufs serves the workspace tree under this path and emits DAV
 * hrefs rooted at it — without the control-plane proxy prefix. WebDAV clients
 * must parse responses against this base, not the full proxied URL, or every
 * listing keeps its own collection as a phantom child. */
export const FILES_DAV_ROOT = "/workspace";
export function standaloneResolver(
  _ports: StandalonePorts,
  controlPlaneOrigin = globalThis.location?.origin ?? "",
): EndpointResolver {
  const cpOrigin = controlPlaneOrigin.replace(/\/+$/u, "");
  const endpoints = (workspace: WorkspaceView): BoxEndpoints => {
    if (cpOrigin === "") throw new Error("control-plane origin is required for workspace surfaces");
    const prefix = `${cpOrigin}/workspaces/${encodeURIComponent(workspace.id)}/webapp`;
    return {
      terminalUrl: `${prefix}/7445/terminal/`,
      filesBase: `${prefix}/7445${FILES_DAV_ROOT}/`,
      // The terminal keeps its http URL and is flipped to wss by
      // `terminalWebSocketUrl`, which also appends `/ws` and needs
      // `window.location` to resolve it. This one is already the exact path the
      // gateway routes, so the scheme swap happens here instead — a resolver
      // used from a test or a worker has no `window` to lean on.
      lodySyncUrl: `${prefix.replace(/^http(s?):\/\//u, "ws$1://")}/7445/lody/sync`,
      lodyRpcUrl: `${prefix}/7445/lody/rpc`,
    };
  };
  return {
    resolve: endpoints,
    previewUrl: (workspace, port) => `${cpOrigin}/workspaces/${encodeURIComponent(workspace.id)}/webapp/7445/preview/${port}/`,
  };
}

export function endpointTarget(url: string): string {
  const parsed = new URL(url);
  const defaultPort = parsed.protocol === "https:" || parsed.protocol === "wss:" ? "443" : "80";
  return `${parsed.hostname}:${parsed.port || defaultPort}`;
}

export function validPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65_535;
}
