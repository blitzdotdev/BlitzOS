#!/usr/bin/env node
// Generates `components/landing-agents.generated.ts`: the monochrome agent marks
// shown in the landing "agent wall" (Section 2). Single source of truth is the
// ACP registry icon set in `@lody/components`; Claude Code and Codex are flagship
// agents excluded from the remote registry, so their marks are inlined here.
//
// Do not hand-edit the generated file. Edit this script and run:
//   pnpm --filter @lody/site-docs generate:landing-agents

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const assetsDir = path.join(repoRoot, 'packages/components/src/components/icons/registry-assets');
const outputPath = path.resolve(__dirname, '../components/landing-agents.generated.ts');

// Flagship agents are excluded from the generated ACP registry (they ship as
// first-party runtimes), so their brand marks are inlined here with currentColor.
const ANTHROPIC_MARK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="currentColor" d="m3.127 10.604l3.135-1.76l.053-.153l-.053-.085H6.11l-.525-.032l-1.791-.048l-1.554-.065l-1.505-.08l-.38-.081L0 7.832l.036-.234l.32-.214l.455.04l1.009.069l1.513.105l1.097.064l1.626.17h.259l.036-.105l-.089-.065l-.068-.064l-1.566-1.062l-1.695-1.121l-.887-.646l-.48-.327l-.243-.306l-.104-.67l.435-.48l.585.04l.15.04l.593.456l1.267.981l1.654 1.218l.242.202l.097-.068l.012-.049l-.109-.181l-.9-1.626l-.96-1.655l-.428-.686l-.113-.411a2 2 0 0 1-.068-.484l.496-.674L4.446 0l.662.089l.279.242l.411.94l.666 1.48l1.033 2.014l.302.597l.162.553l.06.17h.105v-.097l.085-1.134l.157-1.392l.154-1.792l.052-.504l.25-.605l.497-.327l.387.186l.319.456l-.045.294l-.19 1.23l-.37 1.93l-.243 1.29h.142l.161-.16l.654-.868l1.097-1.372l.484-.545l.565-.601l.363-.287h.686l.505.751l-.226.775l-.707.895l-.585.759l-.839 1.13l-.524.904l.048.072l.125-.012l1.897-.403l1.024-.186l1.223-.21l.553.258l.06.263l-.218.536l-1.307.323l-1.533.307l-2.284.54l-.028.02l.032.04l1.029.098l.44.024h1.077l2.005.15l.525.346l.315.424l-.053.323l-.807.411l-3.631-.863l-.872-.218h-.12v.073l.726.71l1.331 1.202l1.667 1.55l.084.383l-.214.302l-.226-.032l-1.464-1.101l-.565-.497l-1.28-1.077h-.084v.113l.295.432l1.557 2.34l.08.718l-.112.234l-.404.141l-.444-.08l-.911-1.28l-.94-1.44l-.759-1.291l-.093.053l-.448 4.821l-.21.246l-.484.186l-.403-.307l-.214-.496l.214-.98l.258-1.28l.21-1.016l.19-1.263l.112-.42l-.008-.028l-.092.012l-.953 1.307l-1.448 1.957l-1.146 1.227l-.274.109l-.477-.247l.045-.44l.266-.39l1.586-2.018l.956-1.25l.617-.723l-.004-.105h-.036l-4.212 2.736l-.75.096l-.324-.302l.04-.496l.154-.162l1.267-.871z"/></svg>';
const OPENAI_MARK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91a6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9a6.046 6.046 0 0 0 .743 7.097a5.98 5.98 0 0 0 .51 4.911a6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206a5.99 5.99 0 0 0 3.997-2.9a6.056 6.056 0 0 0-.747-7.073M13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081l4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494M3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085l4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646M2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.677l5.815 3.355l-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667m2.01-3.023l-.141-.085l-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5l2.607 1.5v2.999l-2.597 1.5l-2.607-1.5z"/></svg>';

// Curated order + display names. Flagships lead; the rest follow the ACP registry.
// `file` references packages/components/.../registry-assets/<file>.svg.
const AGENTS = [
  { id: 'claude-code', name: 'Claude Code', svg: ANTHROPIC_MARK },
  { id: 'codex', name: 'Codex', svg: OPENAI_MARK },
  { id: 'cursor', name: 'Cursor', file: 'cursor.svg' },
  { id: 'gemini', name: 'Gemini', file: 'gemini.svg' },
  { id: 'grok', name: 'Grok', file: 'grok-build.svg' },
  { id: 'deepseek', name: 'DeepSeek', file: 'reasonix.svg' },
  { id: 'copilot', name: 'Copilot', file: 'github-copilot-cli.svg' },
  { id: 'cline', name: 'Cline', file: 'cline.svg' },
  { id: 'goose', name: 'Goose', file: 'goose.svg' },
  { id: 'opencode', name: 'OpenCode', file: 'opencode.svg' },
  { id: 'qwen', name: 'Qwen', file: 'qwen-code.svg' },
  { id: 'kimi', name: 'Kimi', file: 'kimi.svg' },
  { id: 'amp', name: 'Amp', file: 'amp-acp.svg' },
  { id: 'devin', name: 'Devin', file: 'devin.svg' },
  { id: 'factory', name: 'Factory', file: 'factory-droid.svg' },
  { id: 'auggie', name: 'Auggie', file: 'auggie.svg' },
  { id: 'codebuddy', name: 'CodeBuddy', file: 'codebuddy-code.svg' },
  { id: 'cortex', name: 'Cortex', file: 'cortex-code.svg' },
  { id: 'glm', name: 'GLM', file: 'glm-acp-agent.svg' },
  { id: 'mistral', name: 'Mistral', file: 'mistral-vibe.svg' },
  { id: 'kilo', name: 'Kilo', file: 'kilo.svg' },
  { id: 'qoder', name: 'Qoder', file: 'qoder.svg' },
  { id: 'junie', name: 'Junie', file: 'junie.svg' },
  { id: 'nova', name: 'Nova', file: 'nova.svg' },
  { id: 'deepagents', name: 'DeepAgents', file: 'deepagents.svg' },
  { id: 'stakpak', name: 'Stakpak', file: 'stakpak.svg' },
  { id: 'crow', name: 'Crow', file: 'crow-cli.svg' },
  { id: 'corust', name: 'Corust', file: 'corust-agent.svg' },
  { id: 'dimcode', name: 'DimCode', file: 'dimcode.svg' },
  { id: 'dirac', name: 'Dirac', file: 'dirac.svg' },
  { id: 'fast-agent', name: 'Fast Agent', file: 'fast-agent.svg' },
  { id: 'minion', name: 'Minion', file: 'minion-code.svg' },
  { id: 'pi', name: 'Pi', file: 'pi-acp.svg' },
  { id: 'poolside', name: 'Poolside', file: 'poolside.svg' },
  { id: 'sigit', name: 'siGit', file: 'sigit.svg' },
  { id: 'vtcode', name: 'VT Code', file: 'vtcode.svg' },
  { id: 'agoragentic', name: 'Agoragentic', file: 'agoragentic-acp.svg' },
  { id: 'autohand', name: 'Autohand', file: 'autohand.svg' },
];

/** Strip the root <svg> width/height so CSS controls sizing; collapse whitespace. */
function normalizeSvg(raw) {
  return raw
    .replace(/<svg\b[^>]*>/, (tag) => tag.replace(/\s(?:width|height)="[^"]*"/g, ''))
    .replace(/\s*\n\s*/g, ' ')
    .replace(/>\s+</g, '><')
    .trim();
}

const records = AGENTS.map((agent) => {
  const raw = agent.svg ?? readFileSync(path.join(assetsDir, agent.file), 'utf8');
  return { id: agent.id, name: agent.name, svg: normalizeSvg(raw) };
});

const body = records
  .map(
    (r) =>
      `  { id: ${JSON.stringify(r.id)}, name: ${JSON.stringify(r.name)}, svg: ${JSON.stringify(
        r.svg
      )} },`
  )
  .join('\n');

const file = `/* eslint-disable */
// AUTO-GENERATED by scripts/generate-landing-agents.mjs — do not edit by hand.
// Source: packages/components/src/components/icons/registry-assets + flagship marks.

export type LandingAgent = {
  id: string;
  name: string;
  /** Inline, single-color (currentColor) SVG markup. */
  svg: string;
};

export const LANDING_AGENTS: LandingAgent[] = [
${body}
];
`;

writeFileSync(outputPath, file, 'utf8');
process.stdout.write(
  `Generated ${path.relative(repoRoot, outputPath)} with ${records.length} agents\n`
);
