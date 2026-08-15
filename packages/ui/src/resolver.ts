import type { WorkspaceView } from "@blitzos/schema";

export interface BoxEndpoints {
  terminalUrl: string;
  acpUrl: string;
  filesBase: string;
}

export interface EndpointResolver {
  resolve(workspace: WorkspaceView): BoxEndpoints;
  previewUrl(workspace: WorkspaceView, port: number): string;
}

export interface StandalonePorts {
  acp: number;
  files: number;
}

export const DEFAULT_PORTS: StandalonePorts = { acp: 7444, files: 7445 };

export function isMicrovmWorkspace(workspace: WorkspaceView): boolean {
  return workspace.machineTypeId.startsWith("mv-");
}

export function standaloneResolver(
  ports: StandalonePorts,
  controlPlaneOrigin = globalThis.location?.origin ?? "",
): EndpointResolver {
  const filesOrigin = `http://localhost:${ports.files}`;
  const cpOrigin = controlPlaneOrigin.replace(/\/+$/u, "");
  const microvmEndpoints = (workspace: WorkspaceView): BoxEndpoints => {
    if (cpOrigin === "") throw new Error("control-plane origin is required for microVM surfaces");
    const prefix = `${cpOrigin}/workspaces/${encodeURIComponent(workspace.id)}/surface`;
    const acp = new URL(`${prefix}/7444`);
    acp.protocol = acp.protocol === "https:" ? "wss:" : "ws:";
    return {
      terminalUrl: `${prefix}/7445/terminal/`,
      acpUrl: acp.toString(),
      filesBase: `${prefix}/7445/workspace/`,
    };
  };
  return {
    resolve: (workspace) => isMicrovmWorkspace(workspace)
      ? microvmEndpoints(workspace)
      : {
          terminalUrl: `${filesOrigin}/terminal/`,
          acpUrl: `ws://localhost:${ports.acp}`,
          filesBase: `${filesOrigin}/workspace/`,
        },
    previewUrl: (workspace, port) => isMicrovmWorkspace(workspace)
      ? `${cpOrigin}/workspaces/${encodeURIComponent(workspace.id)}/surface/7445/preview/${port}/`
      : `${filesOrigin}/preview/${port}/`,
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
