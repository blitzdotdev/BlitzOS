import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * `src/claude-acp-entry.ts` / `src/codex-acp-entry.ts` import the vendored adapter
 * packages, whose runtime exports point at those packages' `dist/`. A clean checkout
 * has no `dist/`, and an existing one can be stale after a submodule update, so a dev
 * entry point that skips preparation silently launches old adapter capabilities
 * against current adapter source (see `apps/cli/AGENTS.md`).
 *
 * The invariant is the ORDER, not the exact command line: preparation has to happen
 * before anything that bundles or launches the CLI.
 */
const readCliScripts = (): Record<string, string> => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  ) as { scripts?: Record<string, string> };
  return packageJson.scripts ?? {};
};

const PREPARE_STEP = 'pnpm run prepare:acp-adapters';

/** Every script that bundles or launches the development CLI. */
const DEV_ENTRY_SCRIPTS = ['dev'];

/** Anything that reads adapter `dist/`, either by bundling it or by running the CLI. */
const CLI_LAUNCH_PATTERN = /\bnode\b[^&]*\b(dev-build\.mjs|dist-dev\/index\.js)/;

describe('CLI development adapter preparation', () => {
  it('exposes the dev entry points this repo documents', () => {
    const scripts = readCliScripts();
    for (const name of DEV_ENTRY_SCRIPTS) {
      expect(scripts[name], `missing "${name}" script`).toBeTypeOf('string');
    }
    expect(scripts).not.toHaveProperty('dev:jiti');
  });

  it('builds vendored ACP adapters before bundling or starting the development CLI', () => {
    const scripts = readCliScripts();
    for (const name of DEV_ENTRY_SCRIPTS) {
      const script = scripts[name] ?? '';
      const prepareIndex = script.indexOf(PREPARE_STEP);
      expect(prepareIndex, `"${name}" must run ${PREPARE_STEP}`).toBeGreaterThanOrEqual(0);

      const launchMatch = CLI_LAUNCH_PATTERN.exec(script);
      expect(launchMatch, `"${name}" must bundle or launch the CLI`).not.toBeNull();
      expect(
        launchMatch?.index ?? -1,
        `"${name}" must prepare adapters before launching the CLI`
      ).toBeGreaterThan(prepareIndex);
    }
  });
});
