import type { FileStat } from 'webdav';

export type FileNode = {
  id: string;
  kind: 'file' | 'directory';
  name: string;
  path: string;
  size: number | null;
  mtime: number | null;
  fileKind: string;
  children?: FileNode[];
} | {
  id: string;
  kind: 'status';
  path: string;
  status: 'loading' | 'empty' | 'error';
};

const KIND_BY_EXTENSION = new Map([
  ['html', 'HTML text'], ['htm', 'HTML text'],
  ['css', 'CSS'], ['scss', 'Sass'], ['less', 'Less'],
  ['js', 'JavaScript'], ['mjs', 'JavaScript'], ['cjs', 'JavaScript'], ['jsx', 'JavaScript'],
  ['ts', 'TypeScript'], ['tsx', 'TypeScript'], ['mts', 'TypeScript'],
  ['json', 'JSON'], ['jsonl', 'JSON lines'], ['toml', 'TOML'], ['yaml', 'YAML'], ['yml', 'YAML'],
  ['md', 'Markdown'], ['markdown', 'Markdown'], ['txt', 'Plain text'],
  ['py', 'Python'], ['rb', 'Ruby'], ['go', 'Go'], ['rs', 'Rust'], ['java', 'Java'], ['c', 'C'],
  ['h', 'C header'], ['cpp', 'C++'], ['sh', 'Shell script'], ['bash', 'Shell script'],
  ['sql', 'SQL'], ['csv', 'CSV'],
  ['png', 'PNG image'], ['jpg', 'JPEG image'], ['jpeg', 'JPEG image'], ['gif', 'GIF image'],
  ['svg', 'SVG image'], ['webp', 'WebP image'], ['avif', 'AVIF image'], ['ico', 'Icon'],
  ['pdf', 'PDF document'], ['zip', 'ZIP archive'], ['gz', 'Gzip archive'], ['tar', 'Archive'],
  ['lock', 'Lockfile'], ['env', 'Dotenv'],
]);

export function fileKind(name: string, type: 'file' | 'directory'): string {
  if (type === 'directory') return 'Folder';
  const extension = name.includes('.') ? name.split('.').pop()?.toLowerCase() ?? '' : '';
  return KIND_BY_EXTENSION.get(extension) ?? 'Document';
}

/** Finder-style timestamp: time today, otherwise a short date. */
export function finderDate(mtime: number | null, now = Date.now()): string {
  if (mtime === null || Number.isNaN(mtime)) return '--';
  const then = new Date(mtime);
  const today = new Date(now);
  const sameDay = then.getFullYear() === today.getFullYear()
    && then.getMonth() === today.getMonth()
    && then.getDate() === today.getDate();
  if (sameDay) {
    return `Today, ${then.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  }
  return then.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

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
    .sort((left, right) =>
      left.basename.localeCompare(right.basename, undefined, { sensitivity: 'base' }))
    .map((entry): FileNode => {
      const filePath = path ? `${path}/${entry.basename}` : entry.basename;
      const mtime = Date.parse(entry.lastmod);
      const node: FileNode = {
        id: filePath,
        kind: entry.type,
        name: entry.basename,
        path: filePath,
        size: entry.type === 'file' && Number.isFinite(entry.size) ? entry.size : null,
        mtime: Number.isNaN(mtime) ? null : mtime,
        fileKind: fileKind(entry.basename, entry.type),
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
