export interface WorkspaceEnvironment {
  env: Record<string, string>;
  startupScript: string | null;
}

export interface WorkspaceEnvironmentResponse extends WorkspaceEnvironment {
  filesReady: boolean;
}
