import { describe, expect, it } from 'vitest';

import {
  buildFileTree,
  collectChecklistFiles,
  collectSnippetIds,
  fileCheckState,
  nodeCheckState,
  setFileReviewed,
  setNodeReviewed,
  setSnippetReviewed,
  snippetsCheckState,
  toggleNodeReviewed,
  type ChecklistFile,
  type FileTreeDirNode,
} from '../src/review-checklist';

const groups = [
  {
    blocks: [
      { id: 'b1', path: 'packages/app/src/index.ts' },
      { id: 'b2', path: 'packages/app/src/index.ts' },
      { id: 'b3', path: 'packages/app/src/util.ts' },
    ],
  },
  {
    blocks: [
      { id: 'b4', path: 'packages/app/src/index.ts' },
      { id: 'b5', path: 'docs/readme.md' },
    ],
  },
];

function findDir(
  nodes: readonly ReturnType<typeof buildFileTree>[number][],
  name: string
): FileTreeDirNode {
  const node = nodes.find((n) => n.type === 'dir' && n.name === name);
  if (!node || node.type !== 'dir') {
    throw new Error(`dir ${name} not found`);
  }
  return node;
}

describe('collectChecklistFiles', () => {
  it('merges and de-duplicates snippet ids per file in document order', () => {
    const files = collectChecklistFiles(groups);
    expect(files).toEqual<ChecklistFile[]>([
      { path: 'packages/app/src/index.ts', snippetIds: ['b1', 'b2', 'b4'] },
      { path: 'packages/app/src/util.ts', snippetIds: ['b3'] },
      { path: 'docs/readme.md', snippetIds: ['b5'] },
    ]);
  });
});

describe('buildFileTree', () => {
  it('nests files under collapsed single-child directory chains', () => {
    const tree = buildFileTree(collectChecklistFiles(groups));
    // `packages/app/src` collapses into a single node; `docs` is separate.
    const pkg = findDir(tree, 'packages/app/src');
    expect(pkg.children.map((c) => c.type === 'file' && c.name)).toEqual(['index.ts', 'util.ts']);
    const docs = findDir(tree, 'docs');
    expect(docs.children).toHaveLength(1);
  });
});

describe('file / folder derived state', () => {
  const files = collectChecklistFiles(groups);
  const tree = buildFileTree(files);
  const indexFile = files[0]!;

  it('is unchecked when no snippet is reviewed', () => {
    expect(fileCheckState(new Set(), indexFile)).toBe('unchecked');
  });

  it('is indeterminate when only some snippets are reviewed', () => {
    expect(fileCheckState(new Set(['b1']), indexFile)).toBe('indeterminate');
  });

  it('auto-checks the file once every snippet is reviewed (2b)', () => {
    expect(fileCheckState(new Set(['b1', 'b2', 'b4']), indexFile)).toBe('checked');
  });

  it('checking a file marks all of its snippets reviewed (2c)', () => {
    const next = setFileReviewed(new Set(), indexFile, true);
    expect([...next].sort()).toEqual(['b1', 'b2', 'b4']);
    expect(fileCheckState(next, indexFile)).toBe('checked');
  });

  it('cascades a folder check to every snippet beneath it (1c)', () => {
    const pkg = findDir(tree, 'packages/app/src');
    const next = setNodeReviewed(new Set(), pkg, true);
    expect([...next].sort()).toEqual(['b1', 'b2', 'b3', 'b4']);
    expect(nodeCheckState(next, pkg)).toBe('checked');
  });

  it('auto-checks the folder only when all files are reviewed (2d)', () => {
    const pkg = findDir(tree, 'packages/app/src');
    const partial = setFileReviewed(new Set(), indexFile, true);
    expect(nodeCheckState(partial, pkg)).toBe('indeterminate');
    const full = setFileReviewed(partial, files[1]!, true);
    expect(nodeCheckState(full, pkg)).toBe('checked');
  });

  it('unchecking one snippet drops the file and folder back to indeterminate', () => {
    const pkg = findDir(tree, 'packages/app/src');
    const all = setNodeReviewed(new Set(), pkg, true);
    const dropped = setSnippetReviewed(all, 'b2', false);
    expect(fileCheckState(dropped, indexFile)).toBe('indeterminate');
    expect(nodeCheckState(dropped, pkg)).toBe('indeterminate');
  });

  it('toggleNodeReviewed flips a partially-checked node to fully checked', () => {
    const pkg = findDir(tree, 'packages/app/src');
    const partial = setSnippetReviewed(new Set(), 'b1', true);
    const toggled = toggleNodeReviewed(partial, pkg);
    expect(nodeCheckState(toggled, pkg)).toBe('checked');
    expect(toggleNodeReviewed(toggled, pkg)).toEqual(new Set());
  });

  it('derives a group/explicit snippet-set state (file <-> snippet sync, 2a)', () => {
    expect(snippetsCheckState(new Set(['b1', 'b2', 'b4']), ['b1', 'b2', 'b4'])).toBe('checked');
    expect(snippetsCheckState(new Set(['b1']), ['b1', 'b2'])).toBe('indeterminate');
    expect(collectSnippetIds(findDir(tree, 'docs'))).toEqual(['b5']);
  });
});
