import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnGrokRuntime } from '../src/runtime-process.js';

test('hides the official Grok runtime child console on Windows hosts', () => {
  const child = {};
  const env = { GROK_TEST_ENV: 'enabled' };
  let spawnArgs;

  const result = spawnGrokRuntime('C:\\Program Files\\Grok\\grok.exe', {
    env,
    spawnImpl(...args) {
      spawnArgs = args;
      return child;
    },
  });

  assert.equal(result, child);
  assert.deepEqual(spawnArgs, [
    'C:\\Program Files\\Grok\\grok.exe',
    ['agent', 'stdio'],
    {
      env: { ...env, GROK_DISABLE_AUTOUPDATER: '1' },
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
    },
  ]);
});
