#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const publicRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicImporters = ['apps/cli', 'apps/electron', 'packages/components'];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findOwningParentWorkspace() {
  let candidate = path.dirname(publicRoot);

  while (candidate !== path.dirname(candidate)) {
    const workspaceFile = path.join(candidate, 'pnpm-workspace.yaml');
    const lockfile = path.join(candidate, 'pnpm-lock.yaml');
    if (existsSync(workspaceFile) && existsSync(lockfile)) {
      const publicPath = path.relative(candidate, publicRoot).split(path.sep).join('/');
      const lockContents = readFileSync(lockfile, 'utf8');
      const ownsPublicImporter = publicImporters.some((importer) => {
        const importerPath = `${publicPath}/${importer}`;
        return new RegExp(`^  ['\"]?${escapeRegExp(importerPath)}['\"]?:`, 'mu').test(lockContents);
      });

      if (ownsPublicImporter) {
        return candidate;
      }
    }

    candidate = path.dirname(candidate);
  }

  return null;
}

const parentWorkspace = findOwningParentWorkspace();
if (parentWorkspace) {
  console.error(`This public checkout is already embedded in a parent pnpm workspace:
  ${parentWorkspace}

Running pnpm install here would overwrite package links with a second virtual
store and create incompatible dependency identities. Run pnpm install from the
parent workspace root instead. Use a separate clone when developing this public
repository as a standalone workspace.`);
  process.exitCode = 1;
}
