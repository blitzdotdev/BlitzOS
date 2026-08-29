import type { SessionListEntry } from '@/lib/session-visibility';
import {
  getLocalProjectVisibilityKey,
  type VisibleLocalProjectEntry,
} from '@/lib/visible-local-project-index';

export function getSessionPaletteSubtitle(
  session: SessionListEntry,
  localProjects: Map<string, VisibleLocalProjectEntry>
): string | null {
  const projectLabel = resolveSessionProjectLabel(session, localProjects);
  const branchName = session.project?.kind === 'local' ? session.branchName : null;

  if (projectLabel) {
    return branchName ? `${projectLabel} · ${branchName}` : projectLabel;
  }
  return branchName ?? null;
}

/**
 * The project/repo a session belongs to, for the palette subtitle. GitHub sessions use
 * `repoFullName`; local sessions resolve the human-readable project name from the visible
 * local-project index (falling back to a linked GitHub repo, then nothing).
 */
export function resolveSessionProjectLabel(
  session: SessionListEntry,
  localProjects: Map<string, VisibleLocalProjectEntry>
): string | null {
  if (session.project?.kind === 'local') {
    const localProjectId = session.project.localProjectId;
    if (localProjectId) {
      const entry = localProjects.get(
        getLocalProjectVisibilityKey(session.machineId, localProjectId)
      );
      const name = entry?.project.name?.trim();
      if (name) return name;
    }
    return session.project.githubRepoFullName ?? session.repoFullName ?? null;
  }
  return session.repoFullName ?? null;
}
