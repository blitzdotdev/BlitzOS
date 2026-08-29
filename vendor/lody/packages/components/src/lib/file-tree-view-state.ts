/**
 * Cross-mount memory for the file tree's own view state (which directories are
 * expanded, which row is selected).
 *
 * The desktop side panel renders exactly one tab at a time, so opening a file
 * from the Files tab UNMOUNTS the tree while its viewer tab is active. Holding
 * the expanded set in component state alone therefore collapsed every folder as
 * soon as the user came back, which is indistinguishable from the tree resetting
 * itself. The state is keyed per tree (per session) and is deliberately
 * memory-only: it is transient view state, not a user preference worth
 * persisting across reloads.
 */

export type FileTreeViewState = {
  readonly expandedIds: ReadonlySet<string>;
  readonly selectedId: string | undefined;
};

export const EMPTY_FILE_TREE_VIEW_STATE: FileTreeViewState = {
  expandedIds: new Set<string>(),
  selectedId: undefined,
};

// Bounds the map for a long-lived renderer that visits many sessions. Small
// enough to stay negligible, large enough to cover realistic tab switching.
const MAX_TRACKED_TREES = 32;

const statesByKey = new Map<string, FileTreeViewState>();

export function readFileTreeViewState(key: string | undefined): FileTreeViewState {
  if (key === undefined) return EMPTY_FILE_TREE_VIEW_STATE;
  return statesByKey.get(key) ?? EMPTY_FILE_TREE_VIEW_STATE;
}

export function writeFileTreeViewState(key: string | undefined, state: FileTreeViewState): void {
  if (key === undefined) return;
  // Re-insert so iteration order stays least-recently-written first.
  statesByKey.delete(key);
  statesByKey.set(key, state);
  while (statesByKey.size > MAX_TRACKED_TREES) {
    const oldestKey = statesByKey.keys().next().value;
    if (oldestKey === undefined) break;
    statesByKey.delete(oldestKey);
  }
}

export function clearFileTreeViewStates(): void {
  statesByKey.clear();
}
