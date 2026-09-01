#!/usr/bin/env tsx
import { createWriteStream, readFileSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import { collectBundleDiagnostics, hasErrorDiagnostics, unwrapReviewBundle } from './index';
import { createReviewBundleSnapshot, type ReviewBundleInput } from './snapshot';
import { injectReviewSnapshot } from './standalone';
import type { ReviewDiagnostic } from './types';
import { resolveReviewBundle } from './node';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const program = new Command()
  .name('review-helper')
  .description('Local code-review renderer and validator')
  .version('0.0.0')
  .configureHelp({ showGlobalOptions: true });

program
  .command('validate')
  .description('Parse .review.md, resolve Git files, and report diagnostics.')
  .argument('<file>', 'Path to the .review.md file')
  .option('-r, --repo <repo>', 'Git repository directory', process.cwd())
  .action(async (file: string, options: { repo: string }) => {
    const bundle = await resolveReviewBundle({
      reviewFilePath: path.resolve(file),
      repoPath: path.resolve(options.repo),
    });
    const diagnostics = collectBundleDiagnostics(bundle);
    printDiagnostics(diagnostics);
    if (hasErrorDiagnostics(diagnostics)) {
      process.exitCode = 1;
      return;
    }
    if (diagnostics.length === 0) {
      console.log('Review file is valid.');
    }
  });

program
  .command('view')
  .description('Start a local React renderer for the review file.')
  .argument('<file>', 'Path to the .review.md file')
  .option('-r, --repo <repo>', 'Git repository directory', process.cwd())
  .option('--host <host>', 'Server host', '127.0.0.1')
  .option('--port <port>', 'Server port', '4177')
  .action(async (file: string, options: { repo: string; host: string; port: string }) => {
    const bundle = await resolveReviewBundle({
      reviewFilePath: path.resolve(file),
      repoPath: path.resolve(options.repo),
    });
    const diagnostics = collectBundleDiagnostics(bundle);
    printDiagnostics(diagnostics);
    if (hasErrorDiagnostics(diagnostics)) {
      process.exitCode = 1;
      return;
    }
    await startViewer({
      bundle,
      host: options.host,
      port: Number(options.port),
    });
  });

program
  .command('export')
  .description(
    'Export a .review.md + Git repository to a self-contained .review.json or .review.html.'
  )
  .argument('<file>', 'Path to the .review.md file')
  .argument('[output]', 'Output file or directory (omit to print to stdout)')
  .option('-r, --repo <repo>', 'Git repository directory', process.cwd())
  .option(
    '-f, --format <format>',
    'Output format: json, gzip, brotli, or html (self-contained viewer)',
    'json'
  )
  .option('--pretty', 'Pretty-print JSON (only applies to uncompressed json output)')
  .action(
    async (
      file: string,
      output: string | undefined,
      options: { repo: string; format: string; pretty: boolean }
    ) => {
      const format = parseFormat(options.format);
      const bundle = await resolveReviewBundle({
        reviewFilePath: path.resolve(file),
        repoPath: path.resolve(options.repo),
      });
      const diagnostics = collectBundleDiagnostics(bundle);
      printDiagnostics(diagnostics);
      if (hasErrorDiagnostics(diagnostics)) {
        process.exitCode = 1;
        return;
      }

      const snapshot = createReviewBundleSnapshot(bundle);
      const serialized =
        format === 'html'
          ? Buffer.from(renderStandaloneHtml(snapshot), 'utf8')
          : serializeSnapshot(snapshot, format, options.pretty);

      if (output === undefined) {
        process.stdout.write(serialized);
        return;
      }

      const targetPath = await resolveOutputPath(path.resolve(file), output, format);
      await mkdir(path.dirname(targetPath), { recursive: true });
      const stream = createWriteStream(targetPath);
      await new Promise<void>((resolve, reject) => {
        stream.write(serialized, (error) => {
          if (error) {
            reject(error);
          } else {
            stream.end(resolve);
          }
        });
      });
      console.log(`Exported review snapshot to ${targetPath}`);
    }
  );

program.parse();

type ExportFormat = 'json' | 'gzip' | 'brotli' | 'html';

function parseFormat(value: string): ExportFormat {
  if (value === 'json' || value === 'gzip' || value === 'brotli' || value === 'html') {
    return value;
  }
  throw new Error(`Invalid format "${value}". Expected one of: json, gzip, brotli, html.`);
}

const standaloneTemplatePath = path.resolve(packageRoot, 'dist-standalone/standalone.html');

/**
 * Builds a self-contained `.review.html` by splicing the snapshot into the
 * prebuilt standalone viewer template. Requires `pnpm build:standalone` to have
 * produced `dist-standalone/standalone.html`.
 */
function renderStandaloneHtml(snapshot: ReviewBundleInput): string {
  let template: string;
  try {
    template = readFileSync(standaloneTemplatePath, 'utf8');
  } catch {
    throw new Error(
      `Standalone viewer template not found at ${standaloneTemplatePath}. ` +
        'Run "pnpm build:standalone" first.'
    );
  }
  return injectReviewSnapshot(template, snapshot);
}

function serializeSnapshot(
  snapshot: ReturnType<typeof createReviewBundleSnapshot>,
  format: 'json' | 'gzip' | 'brotli',
  pretty: boolean
): Buffer {
  const json = pretty ? JSON.stringify(snapshot, null, 2) : JSON.stringify(snapshot);
  const bytes = Buffer.from(json, 'utf8');
  if (format === 'gzip') {
    return gzipSync(bytes);
  }
  if (format === 'brotli') {
    return brotliCompressSync(bytes);
  }
  return bytes;
}

async function resolveOutputPath(
  inputFilePath: string,
  rawOutput: string,
  format: ExportFormat
): Promise<string> {
  const resolvedOutput = path.resolve(rawOutput);
  let isDirectory = rawOutput.endsWith(path.sep) || rawOutput.endsWith('/');
  if (!isDirectory) {
    try {
      const stats = await stat(resolvedOutput);
      isDirectory = stats.isDirectory();
    } catch {
      // Path does not exist yet; treat as a file path.
    }
  }

  const ext =
    format === 'json'
      ? 'json'
      : format === 'gzip'
        ? 'json.gz'
        : format === 'brotli'
          ? 'json.br'
          : 'html';
  if (!isDirectory) {
    return resolvedOutput;
  }

  const base = path.basename(inputFilePath);
  const nameWithoutMd = base.endsWith('.md') ? base.slice(0, -3) : base;
  const name = nameWithoutMd.endsWith('.review') ? nameWithoutMd : `${nameWithoutMd}.review`;
  return path.join(resolvedOutput, `${name}.${ext}`);
}

function printDiagnostics(diagnostics: readonly ReviewDiagnostic[]): void {
  for (const diagnostic of diagnostics) {
    const location = diagnostic.line === undefined ? '' : `:${diagnostic.line}`;
    const code = diagnostic.code === undefined ? '' : ` [${diagnostic.code}]`;
    const prefix = diagnostic.severity.toUpperCase();
    console.log(`${prefix}${location}${code} ${diagnostic.message}`);
  }
}

async function startViewer(input: {
  readonly bundle: ReviewBundleInput;
  readonly host: string;
  readonly port: number;
}): Promise<void> {
  const [{ createServer }, react] = await Promise.all([
    import('vite'),
    import('@vitejs/plugin-react'),
  ]);
  const serializedBundle = JSON.stringify(unwrapReviewBundle(input.bundle));

  const server = await createServer({
    root: packageRoot,
    configFile: false,
    appType: 'spa',
    plugins: [
      react.default(),
      {
        name: 'review-helper-api',
        configureServer(viteServer) {
          viteServer.middlewares.use('/api/review-bundle', (_req, res) => {
            res.statusCode = 200;
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.end(serializedBundle);
          });
        },
      },
    ],
    server: {
      host: input.host,
      port: input.port,
      strictPort: false,
    },
    worker: {
      format: 'es',
    },
  });

  await server.listen();
  const url = server.resolvedUrls?.local[0] ?? `http://${input.host}:${input.port}/`;
  console.log(`Review helper viewer: ${url}`);
  console.log('Press Ctrl+C to stop.');

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      void server.close().then(resolve);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}
