import type { CliRuntimeState } from '@lody/shared';

export function formatDaemonBackendStatus(runtimeState: CliRuntimeState): string[] {
  const lines = [
    `  Backend Auth: ${runtimeState.backend?.authorization ?? 'unknown'}`,
    `  Backend Link: ${runtimeState.backend?.connection ?? 'unknown'}`,
  ];

  if (!runtimeState.connectedWorkspaces) {
    lines.push('  Workspaces:   unavailable');
    return lines;
  }

  lines.push(`  Workspaces:   ${runtimeState.connectedWorkspaces.length}`);
  for (const workspace of runtimeState.connectedWorkspaces) {
    const label = workspace.slug ? `${workspace.name} (${workspace.slug})` : workspace.name;
    lines.push(`    - ${label} [${workspace.role}]`);
    lines.push(`      ID: ${workspace.id}`);
    lines.push(`      Backend: ${workspace.backendConnection}`);
  }
  return lines;
}
