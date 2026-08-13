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
  terminal: number;
  acp: number;
  files: number;
}

export const DEFAULT_PORTS: StandalonePorts = { terminal: 7443, acp: 7444, files: 7445 };

export function standaloneResolver(ports: StandalonePorts): EndpointResolver {
  return {
    resolve: () => ({
      terminalUrl: `http://localhost:${ports.terminal}/`,
      acpUrl: `ws://localhost:${ports.acp}`,
      filesBase: `http://localhost:${ports.files}/workspace/`,
    }),
    previewUrl: (_workspace, port) => `http://localhost:${port}/`,
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
