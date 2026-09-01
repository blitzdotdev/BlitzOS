type ResolvePreferredBranchArgs = {
  branches: string[];
  preferredBranch?: string | null;
  repoDefaultBranch?: string | null;
  fallbackBranch?: string;
};

function normalizeBranches(branches: string[]): string[] {
  const unique = new Set<string>();
  for (const branch of branches) {
    const next = branch.trim();
    if (!next) continue;
    unique.add(next);
  }
  return Array.from(unique).sort((a, b) => a.localeCompare(b));
}

export function resolvePreferredBranch({
  branches,
  preferredBranch,
  repoDefaultBranch,
  fallbackBranch = 'main',
}: ResolvePreferredBranchArgs): string {
  const normalized = normalizeBranches(branches);
  const branchSet = new Set(normalized);

  const preferred = preferredBranch?.trim();
  if (preferred && branchSet.has(preferred)) {
    return preferred;
  }

  if (branchSet.has('main')) {
    return 'main';
  }

  if (branchSet.has('master')) {
    return 'master';
  }

  const repoDefault = repoDefaultBranch?.trim();
  if (repoDefault && branchSet.has(repoDefault)) {
    return repoDefault;
  }

  if (normalized.length > 0) {
    return normalized[0]!;
  }

  return fallbackBranch;
}
