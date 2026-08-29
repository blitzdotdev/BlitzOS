#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const selfPath = 'scripts/check-code-collab-imports.mjs';
const scannedExtensions = new Set([
  '.cjs',
  '.cts',
  '.js',
  '.json',
  '.jsx',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);
const scannedBaseNames = new Set(['package.json', 'pnpm-workspace.yaml', 'tsconfig.json']);

const forbiddenPatterns = [
  {
    name: 'sibling loro-repo reference',
    regex: /\.\.\/(?:\.\.\/)*loro-repo\b|\.\.\\(?:\.\.\\)*loro-repo\b/g,
  },
  {
    name: '@loro-dev Code Collab package reference',
    regex: /@loro-dev\/(?:code-[A-Za-z0-9_-]+|file-repo)\b/g,
  },
];

async function listCandidateFiles() {
  const { stdout } = await execFileAsync('git', ['ls-files', '-co', '--exclude-standard'], {
    cwd: repoRoot,
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((relativePath) => relativePath !== selfPath)
    .filter((relativePath) => {
      const basename = path.basename(relativePath);
      if (scannedBaseNames.has(basename)) {
        return true;
      }
      return scannedExtensions.has(path.extname(relativePath));
    });
}

function lineNumberAt(content, index) {
  return content.slice(0, index).split('\n').length;
}

async function findViolations(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  let content;
  try {
    content = await readFile(absolutePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const violations = [];

  for (const pattern of forbiddenPatterns) {
    pattern.regex.lastIndex = 0;
    let match;
    while ((match = pattern.regex.exec(content)) != null) {
      violations.push({
        file: relativePath,
        line: lineNumberAt(content, match.index),
        match: match[0],
        rule: pattern.name,
      });
    }
  }

  return violations;
}

async function main() {
  const files = await listCandidateFiles();
  const violations = [];

  for (const file of files) {
    violations.push(...(await findViolations(file)));
  }

  if (violations.length === 0) {
    console.log(`Code Collab import guard passed (${files.length} files scanned).`);
    return;
  }

  console.error('Code Collab import guard failed:');
  for (const violation of violations) {
    console.error(
      `  ${violation.file}:${violation.line} ${violation.rule}: ${JSON.stringify(violation.match)}`
    );
  }
  process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
