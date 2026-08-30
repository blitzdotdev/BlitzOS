import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('./postinstall.mjs', import.meta.url));
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function testEnvironment(overrides = {}) {
  const env = { ...process.env, ...overrides };
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  return env;
}

test('skips generation when the site-docs postinstall switch is enabled', () => {
  const result = spawnSync(process.execPath, [scriptPath], {
    encoding: 'utf8',
    env: testEnvironment({
      LODY_SKIP_SITE_DOCS_POSTINSTALL: '1',
      npm_execpath: '',
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Skipping @lody\/site-docs postinstall generation\./u);
});

test('delegates a JavaScript package-manager entry to the package generate script', async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'lody-site-postinstall-'));
  temporaryDirectories.push(temporaryDirectory);
  const packageManagerEntry = path.join(temporaryDirectory, 'package-manager.mjs');
  await writeFile(
    packageManagerEntry,
    'console.log(JSON.stringify(process.argv.slice(2)));\n',
    'utf8'
  );

  const result = spawnSync(process.execPath, [scriptPath], {
    encoding: 'utf8',
    env: testEnvironment({
      LODY_SKIP_SITE_DOCS_POSTINSTALL: '0',
      npm_execpath: packageManagerEntry,
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), ['run', 'generate']);
});

test('delegates a native package-manager entry to the package generate script', async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'lody-site-postinstall-'));
  temporaryDirectories.push(temporaryDirectory);
  const nativeEntryProbe = path.join(temporaryDirectory, 'native-entry-probe.cjs');
  await writeFile(
    nativeEntryProbe,
    `if (process.argv[1] !== ${JSON.stringify(scriptPath)}) {
  console.log(JSON.stringify(process.argv.slice(1)));
  process.exit(0);
}
`,
    'utf8'
  );

  const result = spawnSync(process.execPath, [scriptPath], {
    encoding: 'utf8',
    env: testEnvironment({
      LODY_SKIP_SITE_DOCS_POSTINSTALL: '0',
      NODE_OPTIONS: `--require=${JSON.stringify(nativeEntryProbe)}`,
      npm_execpath: process.execPath,
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const [scriptArgument, ...args] = JSON.parse(result.stdout.trim());
  assert.equal(path.basename(scriptArgument), 'run');
  assert.deepEqual(args, ['generate']);
});
