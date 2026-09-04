#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { GROK_MODEL_SNAPSHOT_SETTLE_TIMEOUT_MS, GrokAcpCompatibilityProxy } from './proxy.js';
import { spawnGrokRuntime } from './runtime-process.js';

const grokPath = process.env.GROK_PATH;
if (!grokPath) {
  console.error('GROK_PATH must point to the official Grok runtime');
  process.exit(1);
}

const child = spawnGrokRuntime(grokPath);
const proxy = new GrokAcpCompatibilityProxy({
  deferSessionResponseUntilModelSnapshot: true,
});
const deferredResponseTimers = new Map();

function write(stream, message) {
  stream.write(`${JSON.stringify(message)}\n`);
}

function dispatch(output) {
  for (const id of output.settledSessionResponseIds ?? []) {
    const timer = deferredResponseTimers.get(id);
    if (timer) clearTimeout(timer);
    deferredResponseTimers.delete(id);
  }
  for (const message of output.toRuntime) write(child.stdin, message);
  for (const message of output.toClient) write(process.stdout, message);
  for (const id of output.deferredSessionResponseIds ?? []) {
    const existingTimer = deferredResponseTimers.get(id);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
      deferredResponseTimers.delete(id);
      dispatch(proxy.flushPendingSessionResponse(id));
    }, GROK_MODEL_SNAPSHOT_SETTLE_TIMEOUT_MS);
    deferredResponseTimers.set(id, timer);
    timer.unref();
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  try {
    dispatch(proxy.handleClient(JSON.parse(line)));
  } catch (error) {
    console.error(
      `Invalid ACP client message: ${error instanceof Error ? error.message : String(error)}`
    );
  }
});

createInterface({ input: child.stdout }).on('line', (line) => {
  try {
    dispatch(proxy.handleRuntime(JSON.parse(line)));
  } catch (error) {
    console.error(
      `Invalid Grok runtime message: ${error instanceof Error ? error.message : String(error)}`
    );
  }
});

process.stdin.on('end', () => child.stdin.end());
child.on('error', (error) => {
  console.error(`Failed to launch official Grok runtime: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
