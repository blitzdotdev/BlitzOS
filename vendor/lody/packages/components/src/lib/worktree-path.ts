const WORKTREE_ROOT_TOKEN_PATTERN = /[^\s'"`]*\/worktrees\/[0-9a-fA-F-]{36}\/?/g;
const WORKTREE_ROOT_PREFIX_PATTERN = /^[^\s'"`]*\/worktrees\/[0-9a-fA-F-]{36}\/?/;
const WORKTREE_ROOT_ONLY_PATTERN = /^[^\s'"`]*\/worktrees\/[0-9a-fA-F-]{36}\/?$/;
const TEXT_BOUNDARY_PATTERN = /[\s'"`),\]}:;]/;

function hasRelativeTail(input: string, matchStart: number, matchLength: number): boolean {
  const nextChar = input[matchStart + matchLength] ?? '';
  return nextChar.length > 0 && !TEXT_BOUNDARY_PATTERN.test(nextChar);
}

export function normalizeWorktreePath(value: string): string {
  if (!WORKTREE_ROOT_PREFIX_PATTERN.test(value)) {
    return value;
  }

  if (WORKTREE_ROOT_ONLY_PATTERN.test(value)) {
    return '.';
  }

  return value.replace(WORKTREE_ROOT_PREFIX_PATTERN, '');
}

export function normalizeWorktreePathsInText(value: string): string {
  return value.replace(WORKTREE_ROOT_TOKEN_PATTERN, (match, offset, input) =>
    hasRelativeTail(input, offset, match.length) ? '' : '.'
  );
}

export function normalizeWorktreeTitle(title: string): string {
  return normalizeWorktreePathsInText(title);
}
