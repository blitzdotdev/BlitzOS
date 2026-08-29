import type { WorkspaceView } from "@blitzos/schema";

export interface BoxEndpoints {
  terminalUrl: string;
  filesBase: string;
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
