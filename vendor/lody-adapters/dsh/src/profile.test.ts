import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import {
  DEEPSEEK_HARNESS_DEFAULT_SESSION_COMPRESSION,
  DEEPSEEK_HARNESS_NPX_PACKAGES,
  DEEPSEEK_HARNESS_VERSION,
  createDeepSeekHarnessCordisConfig,
} from './profile.js';

describe('DeepSeek Harness profile', () => {
  it('pins the explicit ACP host and Agent preset package closure', () => {
    expect(DEEPSEEK_HARNESS_VERSION).toBe('0.1.1-rc.2');
    expect(new Set(DEEPSEEK_HARNESS_NPX_PACKAGES).size).toBe(DEEPSEEK_HARNESS_NPX_PACKAGES.length);
    expect(DEEPSEEK_HARNESS_NPX_PACKAGES[0]).toBe('@deepseek-ai/dsh-acp-demo');
    expect(DEEPSEEK_HARNESS_NPX_PACKAGES).toEqual(
      expect.arrayContaining([
        '@deepseek-ai/dsh-agent-presets',
        '@deepseek-ai/dsh-agent-tool-presentation',
        '@deepseek-ai/dsh-attachment-local',
        '@deepseek-ai/dsh-mcp-client',
        '@deepseek-ai/dsh-tool-cordis',
        '@deepseek-ai/dsh-tool-pwsh-persistent',
        '@deepseek-ai/dsh-tool-bash-persistent',
        '@deepseek-ai/dsh-agent',
        '@deepseek-ai/dsh-code-runtime',
        '@deepseek-ai/dsh-llm',
        '@deepseek-ai/dsh-sandbox-windows-acl',
        '@deepseek-ai/dsh-scope',
        '@deepseek-ai/dsh-session',
        '@deepseek-ai/dsh-system-prompt',
        '@deepseek-ai/dsh-tools',
      ])
    );
    expect(DEEPSEEK_HARNESS_NPX_PACKAGES).not.toContain('@deepseek-ai/dsh');
  });

  it('generates a credential-free host composition around the adapter and preset root', () => {
    const config = createDeepSeekHarnessCordisConfig(
      '/opt/acp-extension-dsh.js',
      '/opt/deepseek-agent-presets'
    );

    expect(config).toContain("name: '@deepseek-ai/dsh-agent-presets'");
    expect(config).toContain('default: standard');
    expect(config).toContain('path: "/opt/deepseek-agent-presets"');
    expect(config).toContain('openAt: never');
    expect(config).toContain("name: '@deepseek-ai/dsh-code-runtime-worker-thread'");
    expect(config).toContain("name: '@deepseek-ai/dsh-attachment-local'");
    expect(config).not.toContain('\n    models:');
    expect(config).toContain('name: "/opt/acp-extension-dsh.js"');
    expect(config).toContain('compression: zstd');
    expect(config).not.toMatch(/api[_-]?key:\s+[^D\n]/iu);
  });

  it('defaults to upstream-compatible zstd and permits a detected legacy raw root', () => {
    expect(DEEPSEEK_HARNESS_DEFAULT_SESSION_COMPRESSION).toBe('zstd');
    expect(createDeepSeekHarnessCordisConfig('/opt/adapter.js', '/opt/presets')).toContain(
      'compression: zstd'
    );
    expect(createDeepSeekHarnessCordisConfig('/opt/adapter.js', '/opt/presets', 'none')).toContain(
      'compression: none'
    );
  });

  it('installs every plugin referenced by the host and shipped Agent presets', async () => {
    const sources = [
      createDeepSeekHarnessCordisConfig('/opt/acp-extension-dsh.js', '/opt/presets'),
      ...(await Promise.all(
        ['standard', 'code', 'minimal', 'cordis'].map((presetId) =>
          readFile(new URL(`../presets/${presetId}/agent.cordis.yml`, import.meta.url), 'utf8')
        )
      )),
    ];
    const installed = new Set<string>(DEEPSEEK_HARNESS_NPX_PACKAGES);

    for (const source of sources) {
      for (const match of source.matchAll(/name: '(@deepseek-ai\/[^']+)'/gu)) {
        const specifier = match[1];
        if (!specifier) continue;
        const packageName = specifier.split('/').slice(0, 2).join('/');
        expect(installed, `missing npx package for ${specifier}`).toContain(packageName);
      }
    }
  });
});
