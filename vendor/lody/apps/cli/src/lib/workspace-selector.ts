export type WorkspaceSelectorCandidate = {
  id: string;
  slug: string | null;
  name: string;
};

function normalizeSelectorValue(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function findWorkspacesBySelector<T extends WorkspaceSelectorCandidate>(
  workspaces: readonly T[],
  selector: string
): T[] {
  const normalizedSelector = normalizeSelectorValue(selector);
  if (!normalizedSelector) {
    return [];
  }

  const idMatches = workspaces.filter((workspace) => workspace.id === normalizedSelector);
  if (idMatches.length > 0) {
    return idMatches;
  }

  const slugMatches = workspaces.filter(
    (workspace) => normalizeSelectorValue(workspace.slug) === normalizedSelector
  );
  if (slugMatches.length > 0) {
    return slugMatches;
  }

  return workspaces.filter(
    (workspace) => normalizeSelectorValue(workspace.name) === normalizedSelector
  );
}

export function formatWorkspaceCandidate(workspace: WorkspaceSelectorCandidate): string {
  const name = normalizeSelectorValue(workspace.name);
  const slug = normalizeSelectorValue(workspace.slug);
  const details = [slug ? `slug: ${slug}` : undefined, `id: ${workspace.id}`].filter(
    (part): part is string => part !== undefined
  );
  return `${name ?? workspace.id} (${details.join(', ')})`;
}
