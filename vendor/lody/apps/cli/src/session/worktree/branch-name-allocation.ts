import { resolveGitBranchName, type SessionExec } from '@/lib/git/resolve-git-branch-name';

const DEFAULT_MAX_CANDIDATES = 1_000;

export type AvailableBranchNameOptions = {
  maxLength?: number;
  maxCandidates?: number;
};

export const isManagedWorktreeBranchName = (branchName: string): boolean =>
  branchName.startsWith('session/') || branchName.startsWith('lody/');

const normalizeBranchNameForLength = (branchName: string, maxLength?: number): string => {
  const trimmed = branchName.trim();
  if (!trimmed) {
    throw new Error('Branch name is required');
  }
  if (maxLength === undefined || trimmed.length <= maxLength) {
    return trimmed;
  }
  const shortened = trimmed.slice(0, maxLength).replace(/[-./]+$/g, '');
  if (!shortened) {
    throw new Error(`Branch name cannot fit within ${maxLength} characters`);
  }
  return shortened;
};

const appendBranchNameSuffix = (
  baseName: string,
  candidateNumber: number,
  maxLength?: number,
  blockingAncestor?: string
): string => {
  if (candidateNumber === 1) {
    return normalizeBranchNameForLength(baseName, maxLength);
  }
  const suffix = `-${candidateNumber}`;
  if (blockingAncestor) {
    return normalizeBranchNameForLength(
      `${blockingAncestor}${suffix}${baseName.slice(blockingAncestor.length)}`,
      maxLength
    );
  }
  const maxBaseLength = maxLength === undefined ? undefined : maxLength - suffix.length;
  if (maxBaseLength !== undefined && maxBaseLength < 1) {
    throw new Error(`Branch suffix ${suffix} cannot fit within ${maxLength} characters`);
  }
  return `${normalizeBranchNameForLength(baseName, maxBaseLength)}${suffix}`;
};

export const hasLocalBranchNameConflict = (
  candidate: string,
  existingBranchNames: Iterable<string>
): boolean => {
  for (const existing of existingBranchNames) {
    if (
      existing === candidate ||
      existing.startsWith(`${candidate}/`) ||
      candidate.startsWith(`${existing}/`)
    ) {
      return true;
    }
  }
  return false;
};

export const resolveAvailableBranchName = (
  desiredBranchName: string,
  existingBranchNames: Iterable<string>,
  options: AvailableBranchNameOptions = {}
): string => {
  const existing = Array.from(existingBranchNames, (branchName) => branchName.trim()).filter(
    Boolean
  );
  const normalizedDesired = normalizeBranchNameForLength(desiredBranchName, options.maxLength);
  const blockingAncestor = existing
    .filter((branchName) => normalizedDesired.startsWith(`${branchName}/`))
    .sort((left, right) => right.length - left.length)[0];
  const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  for (let candidateNumber = 1; candidateNumber <= maxCandidates; candidateNumber += 1) {
    const candidate = appendBranchNameSuffix(
      normalizedDesired,
      candidateNumber,
      options.maxLength,
      blockingAncestor
    );
    if (!hasLocalBranchNameConflict(candidate, existing)) {
      return candidate;
    }
  }
  throw new Error(`Unable to find an available branch name for ${desiredBranchName}`);
};

const listLocalBranchNames = async (exec: SessionExec, workdir: string): Promise<Set<string>> => {
  const output = await exec(
    'git',
    ['for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads'],
    workdir,
    false
  );
  return new Set(
    output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  );
};

/**
 * Rename a managed placeholder branch without ever attaching to an existing ref.
 *
 * Session.exec intentionally does not reject non-zero command exits, so success is
 * verified by reading HEAD. If another creator wins the candidate between the ref
 * scan and rename, refresh the refs and allocate the next suffix.
 */
export const renameBranchWithAvailableSuffix = async (options: {
  exec: SessionExec;
  workdir: string;
  currentBranch: string;
  desiredBranchName: string;
  maxLength?: number;
  maxCandidates?: number;
}): Promise<string | null> => {
  const unavailable = await listLocalBranchNames(options.exec, options.workdir);
  const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;

  for (let attempt = 0; attempt < maxCandidates; attempt += 1) {
    const candidate = resolveAvailableBranchName(options.desiredBranchName, unavailable, {
      maxLength: options.maxLength,
      maxCandidates,
    });
    await options.exec(
      'git',
      ['branch', '-m', options.currentBranch, candidate],
      options.workdir,
      false
    );

    const actualBranch = await resolveGitBranchName(options.exec, options.workdir);
    if (actualBranch === candidate) {
      return candidate;
    }
    if (actualBranch !== options.currentBranch) {
      return null;
    }

    const refreshed = await listLocalBranchNames(options.exec, options.workdir);
    if (!hasLocalBranchNameConflict(candidate, refreshed)) {
      return null;
    }
    for (const branchName of refreshed) {
      unavailable.add(branchName);
    }
    unavailable.add(candidate);
  }

  throw new Error(`Unable to rename ${options.currentBranch} to an available branch name`);
};
