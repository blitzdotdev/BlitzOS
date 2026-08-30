import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const defaultMaxTextFileBytes = 5 * 1024 * 1024;

export const countWorkingTreeTextFileLines = async (
  workdir: string,
  filePath: string,
  options?: { maxBytes?: number }
): Promise<number | null> => {
  const absolutePath = path.resolve(workdir, filePath);
  const relativePath = path.relative(workdir, absolutePath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }

  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile() || stat.size > (options?.maxBytes ?? defaultMaxTextFileBytes)) {
      return null;
    }
    const content = await fs.readFile(absolutePath);
    if (content.includes(0)) {
      return null;
    }
    if (content.length === 0) {
      return 0;
    }

    let lineCount = 0;
    for (const byte of content) {
      if (byte === 10) {
        lineCount += 1;
      }
    }
    return content[content.length - 1] === 10 ? lineCount : lineCount + 1;
  } catch {
    return null;
  }
};
