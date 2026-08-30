import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { checkClaude, checkCodex, detectCliTypes, __test__ } from '../src/node/cli-detection';

const require = createRequire(import.meta.url);
const {
  checkClaude: checkClaudeCjs,
  checkCodex: checkCodexCjs,
  detectCliTypes: detectCliTypesCjs,
  __test__: cjsTest,
} = require('../src/node/cli-detection.cjs') as {
  checkClaude: (options?: { homeDir?: string }) => string | false;
  checkCodex: (options?: { homeDir?: string }) => string | false;
  detectCliTypes: (options?: { homeDir?: string }) => {
    kimi: string;
    claude: string | null;
    codex: string | null;
    available: string[];
  };
  __test__: {
    resolveHomeDir: (options?: { homeDir?: string }) => string;
  };
};

let tempDirs: string[] = [];

function makeHomeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-cli-detection-'));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '{}\n', 'utf8');
}

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe('CLI auth file detection', () => {
  it('detects Claude Code from ~/.claude.json', () => {
    const homeDir = makeHomeDir();

    expect(checkClaude({ homeDir })).toBe(false);
    expect(__test__.hasClaudeCredentials({ homeDir })).toBe(false);

    writeFile(path.join(homeDir, '.claude.json'));

    expect(checkClaude({ homeDir })).toBe('configured');
    expect(__test__.hasClaudeCredentials({ homeDir })).toBe(true);
  });

  it('detects Claude Code from ~/.claude/ directory as a fallback', () => {
    const homeDir = makeHomeDir();

    expect(checkClaude({ homeDir })).toBe(false);

    fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });

    expect(checkClaude({ homeDir })).toBe('configured');
    expect(__test__.hasClaudeCredentials({ homeDir })).toBe(true);
  });

  it('detects Codex from ~/.codex/auth.json by default', () => {
    const homeDir = makeHomeDir();
    const originalCodexHome = process.env.CODEX_HOME;
    delete process.env.CODEX_HOME;

    try {
      expect(checkCodex({ homeDir })).toBe(false);
      expect(__test__.hasCodexCredentials({ homeDir })).toBe(false);

      writeFile(path.join(homeDir, '.codex', 'auth.json'));

      expect(checkCodex({ homeDir })).toBe('configured');
      expect(__test__.hasCodexCredentials({ homeDir })).toBe(true);
    } finally {
      if (originalCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = originalCodexHome;
      }
    }
  });

  it('honors $CODEX_HOME for Codex auth detection', () => {
    const homeDir = makeHomeDir();
    const originalCodexHome = process.env.CODEX_HOME;
    const customCodexHome = path.join(homeDir, 'custom-codex-home');

    try {
      process.env.CODEX_HOME = customCodexHome;

      // Default ~/.codex/auth.json must NOT count when CODEX_HOME points elsewhere.
      writeFile(path.join(homeDir, '.codex', 'auth.json'));
      expect(checkCodex({ homeDir })).toBe(false);

      writeFile(path.join(customCodexHome, 'auth.json'));
      expect(checkCodex({ homeDir })).toBe('configured');
    } finally {
      if (originalCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = originalCodexHome;
      }
    }
  });

  it('returns available CLI types from auth files', () => {
    const homeDir = makeHomeDir();
    const originalCodexHome = process.env.CODEX_HOME;
    delete process.env.CODEX_HOME;
    try {
      writeFile(path.join(homeDir, '.codex', 'auth.json'));

      expect(detectCliTypes({ homeDir })).toEqual({
        kimi: 'managed-runtime',
        grok: 'managed-runtime',
        claude: null,
        codex: 'configured',
        available: ['kimi', 'grok', 'codex'],
      });
    } finally {
      if (originalCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = originalCodexHome;
      }
    }
  });

  it('keeps the CommonJS entrypoint aligned with the ESM implementation', () => {
    const homeDir = makeHomeDir();
    const originalCodexHome = process.env.CODEX_HOME;
    delete process.env.CODEX_HOME;
    try {
      writeFile(path.join(homeDir, '.claude.json'));
      writeFile(path.join(homeDir, '.codex', 'auth.json'));

      expect(checkClaudeCjs({ homeDir })).toBe('configured');
      expect(checkCodexCjs({ homeDir })).toBe('configured');
      expect(detectCliTypesCjs({ homeDir })).toEqual(detectCliTypes({ homeDir }));
    } finally {
      if (originalCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = originalCodexHome;
      }
    }
  });

  it('keeps injected empty homeDir behavior aligned between ESM and CommonJS', () => {
    expect(__test__.resolveHomeDir({ homeDir: '' })).toBe('');
    expect(cjsTest.resolveHomeDir({ homeDir: '' })).toBe('');
  });
});
