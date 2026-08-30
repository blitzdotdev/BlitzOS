#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(packageRoot, 'src', 'cli.ts');
const forwardedArgs = process.argv[2] === '--' ? process.argv.slice(3) : process.argv.slice(2);

const result = spawnSync(process.execPath, ['--import', 'tsx', cliPath, ...forwardedArgs], {
  cwd: packageRoot,
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 0);
