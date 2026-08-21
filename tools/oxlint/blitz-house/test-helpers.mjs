import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const pluginDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(pluginDirectory, "../../..");
const oxlintPath = resolve(repositoryRoot, "node_modules", ".bin", "oxlint");
const pluginPath = resolve(pluginDirectory, "index.ts");

// oxlint's JSON reporter names files differently per platform: a file:// URL
// of the canonicalized absolute path on macOS (the tmpdir sits behind the
// /var -> /private/var symlink), the plain command-line path on Linux.
// Normalize every shape to the fixture-relative name so tests can compare
// exactly instead of guessing at suffixes.
function fixtureRelativeName(reported, realFixtureDirectory) {
  const asPath = reported.startsWith("file://") ? fileURLToPath(reported) : reported;
  return relative(
    realFixtureDirectory,
    resolve(realFixtureDirectory, asPath),
  ).replaceAll("\\", "/");
}

export function runRule(rule, fixtures, allowFiles = []) {
  const fixtureDirectory = mkdtempSync(resolve(tmpdir(), "blitz-house-"));
  try {
    const configPath = resolve(fixtureDirectory, ".oxlintrc.json");
    writeFileSync(configPath, `${JSON.stringify({
      jsPlugins: [{ name: "blitz-house", specifier: pluginPath }],
      rules: {
        [`blitz-house/${rule}`]: ["error", { allowFiles }],
      },
    }, null, 2)}\n`);
    for (const [filename, source] of Object.entries(fixtures)) {
      writeFileSync(resolve(fixtureDirectory, filename), source);
    }
    const lint = spawnSync(
      oxlintPath,
      ["--config", configPath, "--format", "json", ...Object.keys(fixtures)],
      {
        cwd: fixtureDirectory,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    if (lint.error !== undefined) throw lint.error;
    let report;
    try {
      report = JSON.parse(lint.stdout);
    } catch (error) {
      throw new Error(lint.stderr.trim() || error.message);
    }
    const realFixtureDirectory = realpathSync(fixtureDirectory);
    return report.diagnostics
      .filter((diagnostic) => diagnostic.code === `blitz-house(${rule})`)
      .map((diagnostic) => ({
        ...diagnostic,
        filename: fixtureRelativeName(diagnostic.filename, realFixtureDirectory),
      }));
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
}
