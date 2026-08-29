import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { Command } from 'commander';

import type { ReviewBundleInput } from '@lody/code-review-helper';

import { openBrowser } from '@/utils/open-browser';

/**
 * `lody review` — render a `.review.md` (produced by a coding agent following the
 * Lody review prompt) into a single self-contained HTML file and open it.
 *
 * No Lody login is required; everything runs locally against the current Git repo
 * (read-only). The generated HTML carries a Lody mark in its toolbar — a hook for
 * future in-page agent chat / PR binding, which will need login.
 *
 * Subcommands / shapes:
 *   - `lody review`                  → this help + the 3-step workflow guide
 *   - `lody review prompt`           → print the Code Review prompt to stdout
 *   - `lody review <file.review.md>` → render → write <name>.review.html → open
 */

const ONE_LINER = 'use `npx lody review` to help me review <pull-request-url>';

function printGuide(): void {
  const lines = [
    '',
    'lody review — turn a code review into a self-contained, shareable HTML page.',
    '',
    'Works with any coding agent. Runs fully locally against your Git repo; no Lody',
    'login required. The output is a single .review.html (all JS/CSS inlined) that',
    'opens over file:// with no server — keep it or share it as one file.',
    '',
    'Workflow (each step works whether run by a human or the coding agent itself):',
    '  1. Get the review format:  npx lody review prompt',
    '  2. Following that prompt, inspect the target PR/branch and write a',
    '     `<name>.review.md` (grouped diffs, P0/P1/P2 notes, line references).',
    '     Write it to a temp dir (e.g. your system temp dir), NOT inside the repo,',
    '     so it is not accidentally committed.',
    '  3. Render it:              npx lody review <name>.review.md',
    '     → writes <name>.review.html into your system temp dir, prints the path,',
    '       and opens it.',
    '',
    'AI agents: if you were asked to "review X with lody", do steps 1-3 yourself —',
    'run `npx lody review prompt`, follow it to write the .review.md, then run',
    '`npx lody review <file>`. The prompt output is the authoritative spec; follow it.',
    '',
    '  A human can also kick this off with one sentence to an agent:',
    `    "${ONE_LINER}"`,
    '',
    'Usage',
    '  npx lody review                  Show this guide.',
    '  npx lody review prompt           Print the Code Review prompt (give it to your agent).',
    '  npx lody review <file>           Render a review file to HTML and open it.',
    '                                   <file> = a .review.md, or a .review.json[.gz]',
    '                                   snapshot exported from a previous run.',
    '',
    'Options (for `review <file>`)',
    '  -r, --repo <dir>      Git repo to resolve the review against (default: current dir).',
    '  -o, --output <path>   Output HTML path (default: a file in the system temp dir).',
    '      --no-open         Write the HTML but do not open a browser.',
    '',
    'Requirements',
    '  • Run inside the reviewed repository’s Git working tree, or point --repo at it.',
    '    A .review.md’s line references resolve against that repo, read-only (never mutated).',
    '  • The commits the review references must exist locally — fetch the branch/PR first.',
    '  • A .review.json[.gz] snapshot is self-contained and renders without Git.',
    '',
    'Note: in-browser comments live in localStorage and may not persist across reopens',
    'over file://; use the in-page copy button to save them as Markdown.',
    '',
  ];
  console.log(lines.join('\n'));
}

/** Reads a `.review.json` / `.review.json.gz` / `.review.json.br` snapshot file. */
async function readSnapshotFile(filePath: string): Promise<unknown> {
  const raw = await readFile(filePath);
  let json: Buffer;
  if (raw[0] === 0x1f && raw[1] === 0x8b) {
    json = gunzipSync(raw);
  } else if (filePath.endsWith('.br')) {
    json = brotliDecompressSync(raw);
  } else {
    json = raw;
  }
  return JSON.parse(json.toString('utf8'));
}

/**
 * Derives the default output path for the rendered HTML. We default into the OS temp
 * dir (NOT next to the input) so a generated `.review.html` never lands in — and gets
 * committed to — the reviewed repository. Override with `--output`.
 */
function defaultHtmlOutputPath(inputFilePath: string): string {
  let base = path.basename(inputFilePath);
  // Strip a trailing compression / format extension chain down to the stem.
  base = base.replace(/\.(md|json|gz|br)$/i, '').replace(/\.(json)$/i, '');
  const stem = base.endsWith('.review') ? base : `${base}.review`;
  return path.join(os.tmpdir(), 'lody-review', `${stem}.html`);
}

interface ReviewActionOptions {
  readonly repo: string;
  readonly output?: string;
  readonly open: boolean;
}

async function runRender(file: string, options: ReviewActionOptions): Promise<void> {
  const inputPath = path.resolve(file);
  const isSnapshot = /\.(json|gz|br)$/i.test(inputPath);

  // Resolve the review into a renderable bundle/snapshot.
  let data: ReviewBundleInput;
  if (isSnapshot) {
    const { isReviewBundleSnapshot } = await import('@lody/code-review-helper');
    const parsed = await readSnapshotFile(inputPath);
    if (!isReviewBundleSnapshot(parsed)) {
      console.error(
        `${inputPath} is not a Lody review snapshot. Pass a .review.md, or a .review.json[.gz] ` +
          'produced by `lody review` / `review-helper export`.'
      );
      process.exitCode = 1;
      return;
    }
    data = parsed;
  } else {
    const { resolveReviewBundle } = await import('@lody/code-review-helper/node');
    const { collectBundleDiagnostics, hasErrorDiagnostics, createReviewBundleSnapshot } =
      await import('@lody/code-review-helper');
    const bundle = await resolveReviewBundle({
      reviewFilePath: inputPath,
      repoPath: path.resolve(options.repo),
    });
    const diagnostics = collectBundleDiagnostics(bundle);
    for (const diagnostic of diagnostics) {
      const location = diagnostic.line === undefined ? '' : `:${diagnostic.line}`;
      const code = diagnostic.code === undefined ? '' : ` [${diagnostic.code}]`;
      console.log(`${diagnostic.severity.toUpperCase()}${location}${code} ${diagnostic.message}`);
    }
    if (hasErrorDiagnostics(diagnostics)) {
      process.exitCode = 1;
      return;
    }
    data = createReviewBundleSnapshot(bundle);
  }

  // Fetch (and cache) the single-file viewer, then inline the data into it.
  const { injectReviewSnapshot } = await import('@lody/code-review-helper/standalone');
  const { resolveReviewViewerTemplate } = await import('@/lib/review-viewer');
  const template = await resolveReviewViewerTemplate();
  const html = injectReviewSnapshot(template, data);

  const outputPath = options.output
    ? path.resolve(options.output)
    : defaultHtmlOutputPath(inputPath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html, 'utf8');
  // Always surface the absolute path — by default this lives in a temp dir (kept out of
  // the repo), so the user needs it to re-open, move, or share the file.
  console.log(`Rendered review → ${outputPath}`);

  if (options.open) {
    try {
      await openBrowser(`file://${outputPath}`);
    } catch (error) {
      console.warn(
        `Could not open the browser automatically: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      console.warn(`Open it manually: file://${outputPath}`);
    }
  }
}

export const reviewCommand = new Command('review')
  .description('Render a .review.md into a self-contained HTML review and open it')
  .argument('[file]', 'Path to a .review.md (or .review.json[.gz]) file to render')
  .option('-r, --repo <repo>', 'Git repository directory', process.cwd())
  .option('-o, --output <output>', 'Output HTML path (defaults to a file in the system temp dir)')
  .option('--no-open', 'Do not open the generated HTML in a browser')
  .action(async (file: string | undefined, options: ReviewActionOptions) => {
    if (!file) {
      printGuide();
      return;
    }
    try {
      await runRender(file, options);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

reviewCommand.addCommand(
  new Command('prompt')
    .description('Print the Code Review prompt that teaches an agent to write a .review.md')
    .action(async () => {
      const { reviewPrompt } = await import('@lody/code-review-helper/prompt-text');
      process.stdout.write(reviewPrompt.endsWith('\n') ? reviewPrompt : `${reviewPrompt}\n`);
    })
);
