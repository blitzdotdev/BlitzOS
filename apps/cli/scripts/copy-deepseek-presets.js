#!/usr/bin/env node

import { cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const cliDirectory = path.resolve(scriptDirectory, '..');
const sourceDirectory = path.resolve(cliDirectory, '../../packages/acp-extension-dsh/presets');

/** Copy the pinned official DSH presets beside the bundled ACP adapter. */
export async function copyDeepSeekPresets(outputDirectory) {
  const destinationDirectory = path.join(outputDirectory, 'deepseek-agent-presets');
  await rm(destinationDirectory, { recursive: true, force: true });
  await cp(sourceDirectory, destinationDirectory, { recursive: true });
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const outputDirectory = path.resolve(cliDirectory, process.argv[2] ?? 'dist');
  await copyDeepSeekPresets(outputDirectory);
}
