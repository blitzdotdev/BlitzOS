import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import * as tar from 'tar';
import { compressStream } from 'zstd-stream';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const kimiRoot = join(repoRoot, 'packages/acp-extension-kimi');
const kimiApp = join(kimiRoot, 'apps/kimi-code');
const args = parseArgs(process.argv.slice(2));
const outputDir = resolve(repoRoot, args.output ?? 'dist/kimi-runtime');

if (!args.skipInstall) {
  assertNodeVersion(process.versions.node, '24.15.0');
  await run('corepack', ['pnpm@10.33.0', '--dir', kimiRoot, 'install', '--frozen-lockfile']);
}

if (!args.skipBuild) {
  assertNodeVersion(process.versions.node, '24.15.0');
  await run('corepack', [
    'pnpm@10.33.0',
    '--dir',
    kimiRoot,
    '--filter',
    '@moonshot-ai/kimi-code',
    'build',
  ]);
}

const packageJson = JSON.parse(await readFile(join(kimiApp, 'package.json'), 'utf8'));
const sourceCommit = (await capture('git', ['-C', kimiRoot, 'rev-parse', 'HEAD'])).trim();
const dirty = (await capture('git', ['-C', kimiRoot, 'status', '--porcelain'])).trim() !== '';
if (dirty && !args.allowDirty) {
  throw new Error(
    'Kimi submodule is dirty. Commit the runtime source before packaging, or pass --allow-dirty for a local-only artifact.'
  );
}

const revision = sourceCommit.slice(0, 12);
const runtimeVersion = dirty
  ? `${packageJson.version}-lody.dev.${revision}`
  : `${packageJson.version}-lody.${revision}`;
const archiveBaseName = `lody-kimi-code-${runtimeVersion}`;
const temporaryArchivePath = join(outputDir, `${archiveBaseName}.tar.zst.pending`);
const scratch = await mkdtemp(join(tmpdir(), 'lody-kimi-runtime-'));

try {
  const packageDir = join(scratch, 'package');
  const distDir = join(packageDir, 'dist');
  await mkdir(distDir, { recursive: true });
  await chmod(packageDir, 0o755);
  await chmod(distDir, 0o755);
  await copyFile(join(kimiApp, 'dist/main.mjs'), join(distDir, 'main.mjs'));
  await copyFile(join(kimiApp, 'dist/search-worker.mjs'), join(distDir, 'search-worker.mjs'));
  await chmod(join(distDir, 'main.mjs'), 0o755);
  await chmod(join(distDir, 'search-worker.mjs'), 0o644);
  await writeFile(
    join(packageDir, 'package.json'),
    `${JSON.stringify(
      {
        name: '@moonshot-ai/kimi-code',
        version: packageJson.version,
        private: true,
        type: 'module',
        bin: { kimi: 'dist/main.mjs' },
        engines: packageJson.engines,
        lodyRuntime: { version: runtimeVersion, sourceCommit, dirty },
      },
      null,
      2
    )}\n`
  );
  await chmod(join(packageDir, 'package.json'), 0o644);

  await run(process.execPath, [join(distDir, 'main.mjs'), '--version'], { cwd: scratch });
  await mkdir(outputDir, { recursive: true });
  await createArchive(scratch, temporaryArchivePath);

  const reproducibilityPath = `${temporaryArchivePath}.reproducibility`;
  try {
    await createArchive(scratch, reproducibilityPath);
    const [sha256, reproducedSha256] = await Promise.all([
      sha256File(temporaryArchivePath),
      sha256File(reproducibilityPath),
    ]);
    if (sha256 !== reproducedSha256) {
      throw new Error(
        `Kimi runtime packaging is not reproducible: ${sha256} != ${reproducedSha256}.`
      );
    }
  } finally {
    await rm(reproducibilityPath, { force: true });
  }

  const sha256 = await sha256File(temporaryArchivePath);
  const fileName = `${archiveBaseName}-${sha256.slice(0, 16)}.tar.zst`;
  const archivePath = join(outputDir, fileName);
  await rename(temporaryArchivePath, archivePath);
  const archiveStat = await stat(archivePath);
  const manifest = {
    name: 'kimi-code',
    version: runtimeVersion,
    sourceVersion: packageJson.version,
    sourceCommit,
    publishable: !dirty,
    kind: 'node-package',
    minNodeVersion: minimumNodeVersion(packageJson.engines?.node),
    artifact: {
      fileName,
      sha256,
      size: archiveStat.size,
      compression: 'zstd',
      cmd: 'package/dist/main.mjs',
    },
  };
  const manifestPath = join(outputDir, `${fileName}.json`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ archivePath, manifestPath, ...manifest }, null, 2)}\n`);
} finally {
  await rm(temporaryArchivePath, { force: true });
  await rm(scratch, { recursive: true, force: true });
}

async function createArchive(cwd, archivePath) {
  const entries = [
    'package',
    'package/dist',
    'package/dist/main.mjs',
    'package/dist/search-worker.mjs',
    'package/package.json',
  ];
  const archive = tar.c(
    {
      cwd,
      noDirRecurse: true,
      portable: true,
      mtime: new Date(0),
      noMtime: false,
      sync: false,
    },
    entries
  );
  const compressed = await compressStream(Readable.toWeb(Readable.from(archive)), {
    level: 19,
  });
  await compressed.pipeTo(Writable.toWeb(createWriteStream(archivePath)));
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function run(command, commandArgs, options = {}) {
  const child = spawn(command, commandArgs, { cwd: options.cwd ?? repoRoot, stdio: 'inherit' });
  await waitForExit(child, command);
}

async function capture(command, commandArgs) {
  const child = spawn(command, commandArgs, {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (!child.stdout) throw new Error(`Failed to capture ${command} output.`);
  const chunks = [];
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  await waitForExit(child, command);
  return Buffer.concat(chunks).toString('utf8');
}

function waitForExit(child, command) {
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} failed (${signal ?? `exit ${code}`}).`));
    });
  });
}

function assertNodeVersion(current, required) {
  const parse = (value) => value.split('.').map((part) => Number(part));
  const left = parse(current);
  const right = parse(required);
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] ?? 0) === (right[index] ?? 0)) continue;
    if ((left[index] ?? 0) > (right[index] ?? 0)) return;
    throw new Error(`Kimi runtime build requires Node >=${required}; current Node is ${current}.`);
  }
}

function minimumNodeVersion(range) {
  const match = /^\s*>=\s*(\d+\.\d+\.\d+)\s*$/u.exec(range ?? '');
  if (!match?.[1])
    throw new Error(`Expected a single Kimi minimum Node version, received ${range}.`);
  return match[1];
}

function parseArgs(argv) {
  const parsed = {
    allowDirty: false,
    skipBuild: false,
    skipInstall: false,
    output: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--allow-dirty') parsed.allowDirty = true;
    else if (value === '--skip-build') parsed.skipBuild = true;
    else if (value === '--skip-install') parsed.skipInstall = true;
    else if (value === '--output') {
      const output = argv[index + 1];
      if (!output) throw new Error('--output requires a path.');
      parsed.output = output;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return parsed;
}
