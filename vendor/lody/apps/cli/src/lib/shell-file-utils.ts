import { readFileSync, writeFileSync } from 'fs';
import path from 'path';

const normalizeNewlines = (value: string): string => value.replace(/\r\n/g, '\n');

export const normalizeComparablePath = (value: string): string => {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

export const toSingleQuotedShellString = (value: string): string =>
  `'${value.replace(/'/g, `'\\''`)}'`;

export const writeIfChanged = (filePath: string, content: string, mode = 0o644): void => {
  try {
    const current = normalizeNewlines(readFileSync(filePath, 'utf8'));
    if (current === normalizeNewlines(content)) {
      return;
    }
  } catch {
    // File doesn't exist or can't be read — write it.
  }
  writeFileSync(filePath, content, { encoding: 'utf8', mode });
};
