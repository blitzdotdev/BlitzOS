import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.env.LODY_SKIP_SITE_DOCS_POSTINSTALL === '1') {
  console.log('Skipping @lody/site-docs postinstall generation.');
  process.exit(0);
}

const packageManagerEntry = process.env.npm_execpath;
if (!packageManagerEntry) {
  throw new Error(
    '@lody/site-docs postinstall must be launched through pnpm so npm_execpath is available'
  );
}

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const isJavaScriptEntry = /\.(?:cjs|mjs|js)$/iu.test(packageManagerEntry);
const command = isJavaScriptEntry ? process.execPath : packageManagerEntry;
const args = isJavaScriptEntry ? [packageManagerEntry, 'run', 'generate'] : ['run', 'generate'];
const result = spawnSync(command, args, {
  cwd: packageRoot,
  env: process.env,
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}

if (result.signal) {
  throw new Error(`@lody/site-docs generate terminated by ${result.signal}`);
}

process.exit(result.status ?? 1);
