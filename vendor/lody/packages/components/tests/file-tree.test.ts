import { describe, expect, it } from 'vitest';

import { buildFileTreeFromPaths, markFileTreeModified } from '../src/lib/file-tree';

describe('buildFileTreeFromPaths', () => {
  it('builds a sorted tree with directories before files', () => {
    const tree = buildFileTreeFromPaths([
      'src/index.ts',
      'README.md',
      'src/utils/math.ts',
      'src/components/button.tsx',
    ]);

    expect(tree.map((item) => `${item.type}:${item.path}`)).toEqual([
      'directory:src',
      'file:README.md',
    ]);

    const srcNode = tree[0];
    expect(srcNode?.type).toBe('directory');
    if (!srcNode || srcNode.type !== 'directory') {
      return;
    }

    expect(srcNode.children?.map((item) => `${item.type}:${item.path}`)).toEqual([
      'directory:src/components',
      'directory:src/utils',
      'file:src/index.ts',
    ]);
  });

  it('marks modified files and propagates modified state to parent directories', () => {
    const tree = buildFileTreeFromPaths(
      ['a/b.txt', 'a/c/d.ts', 'x.ts'],
      new Set(['a/c/d.ts', 'x.ts'])
    );

    const aNode = tree.find((item) => item.path === 'a');
    const xNode = tree.find((item) => item.path === 'x.ts');

    expect(aNode?.modified).toBe(true);
    expect(xNode?.modified).toBe(true);

    if (!aNode || aNode.type !== 'directory') {
      return;
    }

    const cNode = aNode.children?.find((item) => item.path === 'a/c');
    const bNode = aNode.children?.find((item) => item.path === 'a/b.txt');

    expect(cNode?.modified).toBe(true);
    expect(bNode?.modified).toBe(false);
  });

  it('ignores empty paths and deduplicates duplicate file entries', () => {
    const tree = buildFileTreeFromPaths(['  ', 'a.txt', 'a.txt', '/dir/file.ts']);
    expect(tree.map((item) => item.path)).toEqual(['/dir', 'a.txt']);

    const dirNode = tree[0];
    expect(dirNode?.type).toBe('directory');
    if (!dirNode || dirNode.type !== 'directory') {
      return;
    }

    expect(dirNode.children?.map((item) => item.path)).toEqual(['/dir/file.ts']);
  });
});

describe('markFileTreeModified', () => {
  it('re-derives modified highlight from the changed-paths set and propagates to directories', () => {
    // Provider trees arrive with every `modified` already false (live metadata
    // strips per-file modifiedTime); the Changes list is the authoritative source.
    const tree = buildFileTreeFromPaths(['a/b.txt', 'a/c/d.ts', 'x.ts']);

    const marked = markFileTreeModified(tree, new Set(['a/c/d.ts']));

    const aNode = marked.find((item) => item.path === 'a');
    const xNode = marked.find((item) => item.path === 'x.ts');
    expect(aNode?.modified).toBe(true);
    expect(xNode?.modified).toBe(false);

    if (!aNode || aNode.type !== 'directory') {
      return;
    }
    const cNode = aNode.children?.find((item) => item.path === 'a/c');
    const bNode = aNode.children?.find((item) => item.path === 'a/b.txt');
    const dNode = cNode?.type === 'directory' ? cNode.children?.[0] : undefined;
    expect(cNode?.modified).toBe(true);
    expect(bNode?.modified).toBe(false);
    expect(dNode?.modified).toBe(true);
  });

  it('clears stale modified flags when a path leaves the changed set', () => {
    const tree = buildFileTreeFromPaths(['a/b.txt'], new Set(['a/b.txt']));
    expect(tree.find((item) => item.path === 'a')?.modified).toBe(true);

    const cleared = markFileTreeModified(tree, new Set());
    const aNode = cleared.find((item) => item.path === 'a');
    expect(aNode?.modified).toBe(false);
    if (!aNode || aNode.type !== 'directory') {
      return;
    }
    expect(aNode.children?.[0]?.modified).toBe(false);
  });

  it('preserves lazy directory placeholders while marking', () => {
    const tree = [
      {
        path: 'pkg',
        type: 'directory' as const,
        lazyDirectoryId: 'dir-1',
        children: [{ path: 'pkg/main.ts', type: 'file' as const, modified: false }],
      },
    ];

    const marked = markFileTreeModified(tree, new Set(['pkg/main.ts']));
    const pkgNode = marked[0];
    expect(pkgNode?.lazyDirectoryId).toBe('dir-1');
    expect(pkgNode?.modified).toBe(true);
  });
});
