import type { FileTreeItem } from '@lody/shared';

type DirNode = {
  type: 'directory';
  name: string;
  path: string;
  children: Map<string, Node>;
};

type FileNode = {
  type: 'file';
  name: string;
  path: string;
  modified: boolean;
};

type Node = DirNode | FileNode;

const nodeToFileTreeItem = (node: Node): FileTreeItem => {
  if (node.type === 'file') {
    return { path: node.path, type: 'file', modified: node.modified };
  }

  const children = Array.from(node.children.values())
    .sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    })
    .map(nodeToFileTreeItem);

  const hasModifiedChildren = children.some((child) => child.modified);

  return { path: node.path, type: 'directory', children, modified: hasModifiedChildren };
};

/**
 * Re-derive the `modified` highlight on an already-built tree from an explicit
 * set of changed file paths (the "Changes list").
 *
 * Why a separate pass instead of `buildFileTreeFromPaths(..., modifiedPaths)`:
 * the live Code Collab metadata snapshot strips per-file `modifiedTime` (it only
 * publishes path + a materialized-text flag), so provider entries can never carry
 * `modified` in production live mode. The authoritative source for "which files
 * changed" is the diff summary that also feeds the Changes sidebar, which arrives
 * independently of (and after) the file tree. This lets the file-tree highlight
 * stay in lockstep with the Changes list regardless of the tree's own source.
 */
export function markFileTreeModified(
  items: readonly FileTreeItem[],
  modifiedPaths: ReadonlySet<string>
): FileTreeItem[] {
  const mark = (item: FileTreeItem): FileTreeItem => {
    if (item.type === 'file') {
      return { ...item, modified: modifiedPaths.has(item.path) };
    }
    const children = (item.children ?? []).map(mark);
    return { ...item, children, modified: children.some((child) => child.modified) };
  };
  return items.map(mark);
}

export function buildFileTreeFromPaths(
  paths: readonly string[],
  modifiedPaths: ReadonlySet<string> = new Set<string>()
): FileTreeItem[] {
  const root: DirNode = {
    type: 'directory',
    name: '',
    path: '',
    children: new Map(),
  };

  for (const path of paths) {
    const trimmed = path.trim();
    if (!trimmed) {
      continue;
    }

    const leadingSlash = trimmed.startsWith('/') ? '/' : '';
    const segments = trimmed.split('/').filter(Boolean);
    if (segments.length === 0) {
      continue;
    }

    let current = root;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (!segment) {
        continue;
      }

      const isLast = index === segments.length - 1;
      const currentPath = `${leadingSlash}${segments.slice(0, index + 1).join('/')}`;

      if (isLast) {
        const existing = current.children.get(segment);
        if (existing?.type === 'directory') {
          continue;
        }
        current.children.set(segment, {
          type: 'file',
          name: segment,
          path: currentPath,
          modified: modifiedPaths.has(currentPath),
        });
        continue;
      }

      const existing = current.children.get(segment);
      if (existing?.type === 'directory') {
        current = existing;
        continue;
      }

      const nextDirectory: DirNode = {
        type: 'directory',
        name: segment,
        path: currentPath,
        children: new Map(),
      };
      current.children.set(segment, nextDirectory);
      current = nextDirectory;
    }
  }

  return Array.from(root.children.values())
    .sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    })
    .map(nodeToFileTreeItem);
}
