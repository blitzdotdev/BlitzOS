import { resolvePreferredBranch } from './branch-selection';

export type ChatLandingBranchSnapshot = {
  branches: string[];
  defaultBranch: string | null;
};

export const getGitHubBranchesCacheId = (workspaceId: string, repoFullName: string): string =>
  `${workspaceId}:${repoFullName}`;

export const normalizeChatLandingBranches = (
  branches: string[],
  defaultBranch?: string | null
): string[] => {
  const normalized = Array.from(
    new Set(branches.map((branch) => branch.trim()).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b));
  const normalizedDefaultBranch = defaultBranch?.trim() || null;
  if (normalizedDefaultBranch && !normalized.includes(normalizedDefaultBranch)) {
    normalized.push(normalizedDefaultBranch);
    normalized.sort((a, b) => a.localeCompare(b));
  }
  return normalized;
};

export const createChatLandingBranchSnapshot = (
  branches: string[],
  defaultBranch?: string | null
): ChatLandingBranchSnapshot => {
  const normalizedDefaultBranch = defaultBranch?.trim() || null;
  return {
    branches: normalizeChatLandingBranches(branches, normalizedDefaultBranch),
    defaultBranch: normalizedDefaultBranch,
  };
};

export const areChatLandingBranchListsEqual = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((branch, index) => branch === right[index]);

export const resolveChatLandingBranchSelection = (
  snapshot: ChatLandingBranchSnapshot,
  selectedBranch: string | null
): string | null => {
  if (snapshot.branches.length === 0) {
    return null;
  }

  return resolvePreferredBranch({
    branches: snapshot.branches,
    preferredBranch: selectedBranch,
    repoDefaultBranch: snapshot.defaultBranch,
  });
};
