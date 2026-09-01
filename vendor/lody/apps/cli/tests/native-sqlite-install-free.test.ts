import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

/**
 * `npx lody` must work where npm install scripts are disabled.
 *
 * That is not a niche configuration: `ignore-scripts=true` in any npmrc (user,
 * project, or `NPM_CONFIG_IGNORE_SCRIPTS` in a hardened image) makes npx skip them,
 * and `pnpm dlx` skips build scripts by default since pnpm 10 unless the package is
 * allow-listed — which a throwaway dlx project never is. better-sqlite3 <=12 built
 * its binding from an `install` script (`prebuild-install || node-gyp rebuild`), so
 * every one of those environments installed a binding-less package and then threw
 * "Could not locate the bindings file" at the first `new Database(...)`, long after
 * startup. 13.0.2 moved to the N-API, ships prebuilt binaries inside the tarball,
 * and dropped the install script entirely.
 *
 * Asserted here rather than left to the version range because the failure is silent
 * at install time and only surfaces on other people's machines.
 */
const require = createRequire(import.meta.url);

describe('better-sqlite3 install-time contract', () => {
  it('needs no install or postinstall script', () => {
    const packageJsonPath = require.resolve('better-sqlite3/package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      version: string;
      gypfile?: boolean;
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.install).toBeUndefined();
    expect(packageJson.scripts?.postinstall).toBeUndefined();
    expect(packageJson.scripts?.preinstall).toBeUndefined();
    // node-gyp treats a package with a binding.gyp as buildable regardless of
    // scripts; `gypfile: false` is what tells it there is nothing to build.
    expect(packageJson.gypfile).toBe(false);
  });

  it('ships a prebuilt binding for this platform that opens a database', () => {
    const packageDir = dirname(require.resolve('better-sqlite3/package.json'));
    // Mirrors better-sqlite3's own lib/binding.js target resolution.
    const isLinuxMusl =
      process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime;
    const target = `${isLinuxMusl ? 'linuxmusl' : process.platform}-${process.arch}`;
    const prebuildPath = join(packageDir, 'prebuilds', `${target}.node`);
    expect(
      readFileSync(prebuildPath).byteLength,
      `no prebuilt binding at ${prebuildPath}`
    ).toBeGreaterThan(0);

    const database = new Database(':memory:');
    try {
      database.exec('CREATE TABLE t(a)');
      database.prepare('INSERT INTO t VALUES (?)').run(1);
      expect(database.prepare('SELECT COUNT(*) AS c FROM t').get()).toEqual({ c: 1 });
    } finally {
      database.close();
    }
  });
});
