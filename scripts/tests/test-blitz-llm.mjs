import assert from 'node:assert/strict';
import os from 'node:os';
import { harnesses } from '../../src/main/blitz/harnesses.mjs';
import { llm } from '../../src/main/blitz/llm.mjs';

const originalDepth = process.env.BLITZ_DEPTH;
const previousEnv = { ...process.env };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let lastCall = null;

await (async function testMetadataAndDepthPropagation() {
  process.env.BLITZ_DEPTH = '3';
  llm._setSpawner(async ({ env, args, cmd }) => {
    lastCall = { env, args, cmd };
    return JSON.stringify({ result: 'ok' });
  });

  const out = await llm('Plan stage: check repo state.', { harness: 'claude', model: 'opus', effort: 'high' });
  assert.equal(out, 'ok');

  const sentPrompt = lastCall.args.at(-1) || '';
  assert.match(sentPrompt, /\[blitzscript runtime metadata — depth 4\]/);
  assert.match(sentPrompt, /Do NOT recurse: no `blitz run`, no spawning sub-agents/);
  assert.match(sentPrompt, /Act-vs-ask boundary: do reversible work on your own;/);
  assert.equal(lastCall.env.BLITZ_DEPTH, '4');
  assert.equal(lastCall.cmd, 'claude');
  assert.equal(process.env.BLITZ_DEPTH, '3');
})();

await (async function testHarnessBuilders() {
  const claude = harnesses.claude.build('ask', { model: 'opus', effort: 'high' });
  assert.equal(claude.cmd, 'claude');
  assert.ok(claude.args.includes('--model'));
  assert.ok(claude.args.includes('opus'));
  assert.ok(claude.args.includes('--effort'));
  assert.ok(claude.args.includes('high'));
  assert.ok(claude.args.includes('--dangerously-skip-permissions'));
  assert.equal(claude.args[0], '--print');

  const codex = harnesses.codex.build('ask', { model: 'o3', effort: 'low' });
  assert.equal(codex.cmd, 'codex');
  assert.ok(codex.args.includes('exec'));
  assert.ok(codex.args.includes('--json'));
  assert.ok(codex.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(codex.args.includes('--skip-git-repo-check'));
  assert.ok(codex.args.includes('-c'));
  assert.ok(codex.args.includes('model="o3"'));
  assert.ok(codex.args.includes('model_reasoning_effort="low"'));
  assert.equal(codex.args[codex.args.length - 1], 'ask');
})();

await (async function testParseSamples() {
  const claudeStdout = JSON.stringify({
    type: 'result',
    is_error: false,
    result: 'Hello from Claude.',
  });
  assert.equal(harnesses.claude.parse(claudeStdout), 'Hello from Claude.');

  const codexStdout = [
    '{"type":"thread.started","thread_id":"019edd16-63bd-7982-83ec-a302c598c127"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"PONG."}}',
  ].join('\n');
  assert.equal(harnesses.codex.parse(codexStdout), 'PONG.');
})();

await (async function testSemaphoreBounds() {
  let active = 0;
  let maxObserved = 0;
  const limit = Math.max(2, os.cpus().length - 2);
  process.env.BLITZ_DEPTH = '0';
  llm._setConcurrencyLimit(limit);

  llm._setSpawner(async () => {
    active += 1;
    maxObserved = Math.max(maxObserved, active);
    await sleep(50);
    active -= 1;
    return JSON.stringify({ result: 'ok' });
  });

  const tasks = [];
  for (let i = 0; i < 12; i += 1) {
    tasks.push(llm('parallel leaf', { harness: 'claude', effort: 'low' }));
  }
  await Promise.all(tasks);
  assert.equal(maxObserved, limit);
})();

await (async function testMetadataDepthIncrement() {
  process.env.BLITZ_DEPTH = '9';
  llm._setSpawner(async ({ env, args }) => {
    lastCall = { env, args };
    return JSON.stringify({ result: args.at(-1).includes('depth 10') ? 'ten' : 'bad' });
  });
  const out = await llm('one more', { harness: 'claude' });
  assert.equal(out, 'ten');
  assert.equal(lastCall.env.BLITZ_DEPTH, '10');
})();

Object.assign(process.env, previousEnv);
if (originalDepth === undefined) {
  delete process.env.BLITZ_DEPTH;
} else {
  process.env.BLITZ_DEPTH = originalDepth;
}

console.log('test-blitz-llm.mjs passed');
