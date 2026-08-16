import { describe, expect, it } from 'vitest';
import { collectDropped, type DropItemSource } from '../src/files/drop-upload.js';

interface FakeEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (resolve: (file: File) => void, reject: (error: Error) => void) => void;
  createReader?: () => {
    readEntries: (
      resolve: (entries: FakeEntry[]) => void,
      reject: (error: Error) => void,
    ) => void;
  };
}

function fileEntry(name: string): FakeEntry {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (resolve) => resolve(new File([`content of ${name}`], name)),
  };
}

/** Mimics the real reader contract: results arrive in batches and the end is
 * signalled by an empty batch, so a single readEntries call would truncate. */
function dirEntry(name: string, children: FakeEntry[], batchSize = 2): FakeEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let cursor = 0;
      return {
        readEntries: (resolve) => {
          const batch = children.slice(cursor, cursor + batchSize);
          cursor += batch.length;
          resolve(batch);
        },
      };
    },
  };
}

function item(entry: FakeEntry | null): DropItemSource {
  return { webkitGetAsEntry: () => entry };
}

describe('drop payload traversal', () => {
  it('splits loose files from directories and keeps paths relative to each directory', async () => {
    const payload = await collectDropped([
      item(fileEntry('notes.md')),
      item(dirEntry('project', [
        fileEntry('readme.md'),
        dirEntry('src', [fileEntry('main.ts'), fileEntry('util.ts')]),
        fileEntry('license'),
      ])),
    ], []);

    expect(payload.files.map(({ relativePath }) => relativePath)).toEqual(['notes.md']);
    expect(payload.folders).toHaveLength(1);
    expect(payload.folders[0]?.name).toBe('project');
    expect(payload.folders[0]?.files.map(({ relativePath }) => relativePath)).toEqual([
      'readme.md',
      'src/main.ts',
      'src/util.ts',
      'license',
    ]);
    expect(await payload.folders[0]?.files[1]?.file.text()).toBe('content of main.ts');
  });

  it('drains multi-batch directory readers instead of stopping at the first batch', async () => {
    const children = ['a', 'b', 'c', 'd', 'e'].map((name) => fileEntry(`${name}.txt`));
    const payload = await collectDropped([item(dirEntry('big', children, 2))], []);
    expect(payload.folders[0]?.files).toHaveLength(5);
  });

  it('falls back to the plain file list when no item exposes an entry', async () => {
    const fallback = [new File(['x'], 'plain.txt')];
    const payload = await collectDropped([{ webkitGetAsEntry: () => null }, {}], fallback);
    expect(payload.folders).toEqual([]);
    expect(payload.files.map(({ relativePath }) => relativePath)).toEqual(['plain.txt']);
  });

  it('ignores the fallback list when entries exist so files are not doubled', async () => {
    const payload = await collectDropped(
      [item(fileEntry('real.txt'))],
      [new File(['x'], 'real.txt')],
    );
    expect(payload.files).toHaveLength(1);
  });
});
