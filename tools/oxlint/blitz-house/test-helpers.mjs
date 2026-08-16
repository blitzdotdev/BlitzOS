import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const pluginDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(pluginDirectory, "../../..");
const oxlintPath = resolve(repositoryRoot, "node_modules", ".bin", "oxlint");
const pluginPath = resolve(pluginDirectory, "index.ts");

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
    return report.diagnostics.filter(
      (diagnostic) => diagnostic.code === `blitz-house(${rule})`,
    );
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
}
