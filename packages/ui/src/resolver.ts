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
      terminalUrl: `ws://localhost:${ports.terminal}/ws`,
      acpUrl: `ws://localhost:${ports.acp}`,
      filesBase: `http://localhost:${ports.files}/workspace/`,
    }),
    previewUrl: (_workspace, port) => `http://localhost:${port}/`,
  };
}

export function validPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65_535;
}
