import type { FileStat } from 'webdav';

export type FileNode = {
  id: string;
  kind: 'file' | 'directory';
  name: string;
  path: string;
  children?: FileNode[];
} | {
  id: string;
  kind: 'status';
  path: string;
  status: 'loading' | 'empty' | 'error';
};

export function statusNode(path: string, status: 'loading' | 'empty' | 'error'): FileNode {
  return {
    id: `//status/${status}/${path}`,
    kind: 'status',
    path,
    status,
  };
}

export function listedNodes(path: string, entries: FileStat[]): FileNode[] {
  return entries
    .filter(({ basename }) => basename.length > 0)
    .sort((left, right) => (
      left.type === right.type
        ? left.basename.localeCompare(right.basename, undefined, { sensitivity: 'base' })
        : left.type === 'directory' ? -1 : 1
    ))
    .map((entry): FileNode => {
      const filePath = path ? `${path}/${entry.basename}` : entry.basename;
      const node: FileNode = {
        id: filePath,
        kind: entry.type,
        name: entry.basename,
        path: filePath,
      };
      if (entry.type === 'directory') node.children = [statusNode(filePath, 'loading')];
      return node;
    });
}

export function replaceDirectory(
  nodes: FileNode[],
  path: string,
  children: FileNode[],
): FileNode[] {
  return nodes.map((node) => {
    if (node.kind !== 'directory') return node;
    if (node.path === path) return { ...node, children };
    if (!node.children) return node;
    return { ...node, children: replaceDirectory(node.children, path, children) };
  });
}

// Rebuilds the tree from fresh listings while keeping the already-loaded
// children of directories the refresh did not list.
export function mergedTree(previous: FileNode[], listings: Map<string, FileStat[]>): FileNode[] {
  const rootEntries = listings.get('');
  if (rootEntries === undefined) return previous;
  const previousChildren = new Map<string, FileNode[]>();
  const collect = (nodes: FileNode[]) => {
    for (const node of nodes) {
      if (node.kind !== 'directory' || !node.children) continue;
      previousChildren.set(node.path, node.children);
      collect(node.children);
    }
  };
  collect(previous);
  const graft = (nodes: FileNode[]): FileNode[] => nodes.map((node) => {
    if (node.kind !== 'directory') return node;
    const entries = listings.get(node.path);
    if (entries === undefined) {
      return { ...node, children: previousChildren.get(node.path) ?? node.children };
    }
    const children = graft(listedNodes(node.path, entries));
    return { ...node, children: children.length > 0 ? children : [statusNode(node.path, 'empty')] };
  });
  return graft(listedNodes('', rootEntries));
}
