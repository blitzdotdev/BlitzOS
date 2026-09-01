/**
 * Review checklist state.
 *
 * A reviewer marks individual code snippets (diff blocks) as reviewed. Files,
 * folders, and groups are NOT independent state — they are derived from the set
 * of reviewed snippet ids, which keeps every checkbox in the UI in sync:
 *
 * - a file is reviewed when all of its snippets are reviewed;
 * - a folder is reviewed when all files beneath it are reviewed;
 * - checking a file/folder simply marks all of its snippets reviewed.
 *
 * This module is pure (no React) so the cascade logic can be unit-tested.
 */

export type ReviewCheckState = 'checked' | 'unchecked' | 'indeterminate';

/** The reviewed set is the single source of truth: reviewed snippet (block) ids. */
export type ReviewedSnippets = ReadonlySet<string>;

export interface ChecklistFile {
  readonly path: string;
  /** Snippet (diff block) ids that belong to this file, in document order. */
  readonly snippetIds: readonly string[];
}

export interface FileTreeFileNode {
  readonly type: 'file';
  readonly name: string;
  readonly path: string;
  readonly snippetIds: readonly string[];
}

export interface FileTreeDirNode {
  readonly type: 'dir';
  /** Display name (may join collapsed single-child segments, e.g. `a/b`). */
  readonly name: string;
  /** Full directory path from the repo root, used as a stable id. */
  readonly path: string;
  readonly children: readonly FileTreeNode[];
}

export type FileTreeNode = FileTreeFileNode | FileTreeDirNode;

/**
 * Collect the unique reviewable files from review groups. A file may appear in
 * several groups; its snippet ids are merged (de-duplicated, document order).
 */
export function collectChecklistFiles(
  groups: readonly { readonly blocks: readonly { readonly id: string; readonly path: string }[] }[]
): ChecklistFile[] {
  const order: string[] = [];
  const byPath = new Map<string, string[]>();
  for (const group of groups) {
    for (const block of group.blocks) {
      let ids = byPath.get(block.path);
      if (!ids) {
        ids = [];
        byPath.set(block.path, ids);
        order.push(block.path);
      }
      if (!ids.includes(block.id)) {
        ids.push(block.id);
      }
    }
  }
  return order.map((path) => ({ path, snippetIds: byPath.get(path) ?? [] }));
}

interface MutableDir {
  readonly type: 'dir';
  name: string;
  path: string;
  readonly dirs: Map<string, MutableDir>;
  readonly files: FileTreeFileNode[];
}

function createDir(name: string, path: string): MutableDir {
  return { type: 'dir', name, path, dirs: new Map(), files: [] };
}

/**
 * Build a folder/file tree from a flat file list. Single-child directory chains
 * are collapsed (`packages/adaptors/src`) for a compact, VS Code-like tree.
 */
export function buildFileTree(files: readonly ChecklistFile[]): FileTreeNode[] {
  const root = createDir('', '');
  for (const file of files) {
    const segments = file.path.split('/');
    const fileName = segments.pop() ?? file.path;
    let dir = root;
    let prefix = '';
    for (const segment of segments) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      let next = dir.dirs.get(segment);
      if (!next) {
        next = createDir(segment, prefix);
        dir.dirs.set(segment, next);
      }
      dir = next;
    }
    dir.files.push({
      type: 'file',
      name: fileName,
      path: file.path,
      snippetIds: file.snippetIds,
    });
  }
  return [...finalizeDir(root).children];
}

function finalizeDir(dir: MutableDir): FileTreeDirNode {
  const children: FileTreeNode[] = [];
  for (const child of dir.dirs.values()) {
    let node = finalizeDir(child);
    // Collapse a directory that holds exactly one subdirectory and no files.
    while (node.children.length === 1 && node.children[0]?.type === 'dir') {
      const only = node.children[0] as FileTreeDirNode;
      node = {
        type: 'dir',
        name: `${node.name}/${only.name}`,
        path: only.path,
        children: only.children,
      };
    }
    children.push(node);
  }
  children.push(...dir.files);
  return { type: 'dir', name: dir.name, path: dir.path, children };
}

/** All snippet ids beneath a tree node (the node itself if it is a file). */
export function collectSnippetIds(node: FileTreeNode): string[] {
  if (node.type === 'file') {
    return [...node.snippetIds];
  }
  return node.children.flatMap(collectSnippetIds);
}

function aggregate(reviewed: ReviewedSnippets, snippetIds: readonly string[]): ReviewCheckState {
  if (snippetIds.length === 0) {
    return 'unchecked';
  }
  let checked = 0;
  for (const id of snippetIds) {
    if (reviewed.has(id)) {
      checked += 1;
    }
  }
  if (checked === 0) {
    return 'unchecked';
  }
  return checked === snippetIds.length ? 'checked' : 'indeterminate';
}

export function snippetCheckState(reviewed: ReviewedSnippets, snippetId: string): ReviewCheckState {
  return reviewed.has(snippetId) ? 'checked' : 'unchecked';
}

export function fileCheckState(reviewed: ReviewedSnippets, file: ChecklistFile): ReviewCheckState {
  return aggregate(reviewed, file.snippetIds);
}

export function nodeCheckState(reviewed: ReviewedSnippets, node: FileTreeNode): ReviewCheckState {
  return aggregate(reviewed, collectSnippetIds(node));
}

/** Check state across an explicit set of snippet ids (e.g. a group's blocks). */
export function snippetsCheckState(
  reviewed: ReviewedSnippets,
  snippetIds: readonly string[]
): ReviewCheckState {
  return aggregate(reviewed, snippetIds);
}

function withSnippets(
  reviewed: ReviewedSnippets,
  snippetIds: readonly string[],
  checked: boolean
): Set<string> {
  const next = new Set(reviewed);
  for (const id of snippetIds) {
    if (checked) {
      next.add(id);
    } else {
      next.delete(id);
    }
  }
  return next;
}

export function setSnippetReviewed(
  reviewed: ReviewedSnippets,
  snippetId: string,
  checked: boolean
): Set<string> {
  return withSnippets(reviewed, [snippetId], checked);
}

export function setSnippetsReviewed(
  reviewed: ReviewedSnippets,
  snippetIds: readonly string[],
  checked: boolean
): Set<string> {
  return withSnippets(reviewed, snippetIds, checked);
}

export function setFileReviewed(
  reviewed: ReviewedSnippets,
  file: ChecklistFile,
  checked: boolean
): Set<string> {
  return withSnippets(reviewed, file.snippetIds, checked);
}

export function setNodeReviewed(
  reviewed: ReviewedSnippets,
  node: FileTreeNode,
  checked: boolean
): Set<string> {
  return withSnippets(reviewed, collectSnippetIds(node), checked);
}

/** Toggling a node/file flips toward "fully checked" unless already fully checked. */
export function toggleNodeReviewed(reviewed: ReviewedSnippets, node: FileTreeNode): Set<string> {
  return setNodeReviewed(reviewed, node, nodeCheckState(reviewed, node) !== 'checked');
}
