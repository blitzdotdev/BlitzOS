#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve } from "node:path";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const baselinePath = resolve(repositoryRoot, "lint-baseline.json");
const oxlintPath = resolve(repositoryRoot, "node_modules", ".bin", "oxlint");
const lintArguments = [
  "--format",
  "json",
  "--ignore-pattern",
  "packages/**/test/**",
  "--ignore-pattern",
  "packages/**/tests/**",
  "--ignore-pattern",
  "packages/**/*.test.*",
  "--ignore-pattern",
  "packages/**/*.spec.*",
  "packages",
];

function fail(message) {
  console.error(`Lint gate could not run: ${message}`);
  process.exit(1);
}

function ruleName(code) {
  const match = /^(anti-slop|blitz-house)\(([^)]+)\)$/u.exec(code);
  return match === null ? null : `${match[1]}/${match[2]}`;
}

function repositoryFilename(filename) {
  const path = filename.startsWith("file:") ? fileURLToPath(filename) : filename;
  return relative(repositoryRoot, path).replaceAll("\\", "/");
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
} catch (error) {
  fail(`cannot read lint-baseline.json (${error.message})`);
}
if (typeof baseline !== "object" || baseline === null || Array.isArray(baseline)) {
  fail("lint-baseline.json must contain an object");
}
for (const [rule, count] of Object.entries(baseline)) {
  if (
    !/^(anti-slop|blitz-house)\//u.test(rule) ||
    !Number.isInteger(count) ||
    count < 0
  ) {
    fail(`invalid baseline entry ${JSON.stringify(rule)}: ${JSON.stringify(count)}`);
  }
}

const lint = spawnSync(oxlintPath, lintArguments, {
  cwd: repositoryRoot,
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
});
if (lint.error !== undefined) fail(lint.error.message);
if (lint.signal !== null) fail(`Oxlint was terminated by ${lint.signal}`);

let report;
try {
  report = JSON.parse(lint.stdout);
} catch (error) {
  const detail = lint.stderr.trim() || lint.stdout.trim() || error.message;
  fail(`Oxlint did not return a JSON report (${detail})`);
}
if (!Array.isArray(report.diagnostics)) fail("Oxlint JSON has no diagnostics array");
if (!Number.isInteger(report.number_of_files) || report.number_of_files === 0) {
  fail("Oxlint did not inspect any files");
}

const counts = new Map();
const maxLinesFiles = [];
for (const diagnostic of report.diagnostics) {
  const rule = ruleName(diagnostic.code);
  if (rule !== null) counts.set(rule, (counts.get(rule) ?? 0) + 1);
  if (diagnostic.code === "eslint(max-lines)") {
    maxLinesFiles.push(repositoryFilename(diagnostic.filename));
  }
}

const rules = [...new Set([...Object.keys(baseline), ...counts.keys()])].sort();
const regressions = [];
const improvements = [];
console.log("Lint ratchet (packages source; tests excluded):");
for (const rule of rules) {
  const current = counts.get(rule) ?? 0;
  const limit = baseline[rule] ?? 0;
  console.log(`  ${rule}: ${current} (baseline ${limit})`);
  if (current > limit) regressions.push({ rule, current, limit });
  if (current < limit) improvements.push({ rule, current, limit });
}

maxLinesFiles.sort();
console.log(`Max-lines warnings: ${maxLinesFiles.length}`);
for (const filename of maxLinesFiles) console.log(`  ${filename}`);

if (improvements.length > 0) {
  console.log("Lint counts improved; ratchet lint-baseline.json down:");
  for (const { rule, current, limit } of improvements) {
    console.log(`  ${rule}: ${limit} -> ${current}`);
  }
}
if (regressions.length > 0) {
  console.error("Lint gate failed; findings exceed the checked-in baseline:");
  for (const { rule, current, limit } of regressions) {
    console.error(`  ${rule}: ${current} > ${limit} (+${current - limit})`);
  }
  process.exit(1);
}

const antiSlopTotal = [...counts]
  .filter(([rule]) => rule.startsWith("anti-slop/"))
  .reduce((total, [, count]) => total + count, 0);
const houseTotal = [...counts]
  .filter(([rule]) => rule.startsWith("blitz-house/"))
  .reduce((total, [, count]) => total + count, 0);
console.log(
  `Lint gate passed: ${antiSlopTotal} anti-slop findings; ${houseTotal} blitz-house findings.`,
);
