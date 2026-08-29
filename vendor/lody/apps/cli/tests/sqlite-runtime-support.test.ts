import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  describeUnsupportedRuntime,
  isArchSupported,
  isNodeApiVersionSupported,
  REQUIRED_NODE_API_VERSION,
  SUPPORTED_ARCHS,
} from '../src/utils/sqlite-runtime-support';

const require = createRequire(import.meta.url);
const sqliteDir = dirname(require.resolve('better-sqlite3/package.json'));

describe('SQLite runtime support guard', () => {
  it('rejects every runtime below the Node-API version the binding is built against', () => {
    // Node-API 9 is Node 22.0-22.13 — supported by better-sqlite3 12, segfaults on 13.
    expect(isNodeApiVersionSupported('9')).toBe(false);
    expect(isNodeApiVersionSupported(undefined)).toBe(false);
    expect(isNodeApiVersionSupported('')).toBe(false);
    expect(isNodeApiVersionSupported('not-a-number')).toBe(false);

    expect(isNodeApiVersionSupported('10')).toBe(true);
    expect(isNodeApiVersionSupported('11')).toBe(true);
  });

  it('rejects architectures that have no prebuilt binding and cannot build one', () => {
    // armv7 had `linux-arm`/`linuxmusl-arm` prebuilds under 12.x and has none under 13.
    expect(isArchSupported('arm')).toBe(false);
    expect(isArchSupported('ia32')).toBe(false);
    expect(isArchSupported('x64')).toBe(true);
    expect(isArchSupported('arm64')).toBe(true);
  });

  it('reports the architecture first, since upgrading Node cannot fix armv7', () => {
    const message = describeUnsupportedRuntime({ napi: '9', arch: 'arm' });
    expect(message).toContain('arm');
    expect(message).not.toContain('Upgrade Node');

    expect(describeUnsupportedRuntime({ napi: '9', arch: 'x64' })).toContain('v22.14.0');
    expect(describeUnsupportedRuntime({ napi: '10', arch: 'x64' })).toBeUndefined();
  });

  it('matches the NAPI_VERSION better-sqlite3 is actually compiled with', () => {
    // If better-sqlite3 raises NAPI_VERSION, the runtime floor moves with it and this
    // guard would silently let a segfaulting runtime through.
    const declared = /NAPI_VERSION=(\d+)/.exec(
      readFileSync(`${sqliteDir}/binding.gyp`, 'utf8')
    )?.[1];
    expect(declared, 'NAPI_VERSION not found in better-sqlite3/binding.gyp').toBeDefined();
    expect(Number(declared)).toBe(REQUIRED_NODE_API_VERSION);
  });

  it('matches the architectures better-sqlite3 actually ships binaries for', () => {
    const shipped = new Set(
      readdirSync(`${sqliteDir}/prebuilds`).map(
        (file) => file.replace(/\.node$/, '').split('-')[1]
      )
    );
    expect([...shipped].sort()).toEqual([...SUPPORTED_ARCHS].sort());
  });

  it('declares an engines range that cannot admit an unsupported runtime', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    ) as { engines?: { node?: string } };
    // Node-API 10 landed in 22.14.0; anything looser lets npm install onto a runtime
    // that crashes. engines is only a warning, hence the runtime guard as well.
    expect(packageJson.engines?.node).toBe('>=22.14.0');
  });
});
