import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { resolveProxyAgent, resolveProxyUrl } from './proxy';

const snapshotEnv = (): NodeJS.ProcessEnv => ({ ...process.env });

const restoreEnv = (snapshot: NodeJS.ProcessEnv): void => {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (typeof value === 'string') {
      process.env[key] = value;
    }
  }
};

const clearProxyEnv = (): void => {
  for (const key of [
    'ALL_PROXY',
    'all_proxy',
    'HTTP_PROXY',
    'http_proxy',
    'HTTPS_PROXY',
    'https_proxy',
    'WS_PROXY',
    'ws_proxy',
    'WSS_PROXY',
    'wss_proxy',
    'NO_PROXY',
    'no_proxy',
    'npm_config_proxy',
    'npm_config_http_proxy',
    'npm_config_https_proxy',
    'npm_config_ws_proxy',
    'npm_config_wss_proxy',
  ]) {
    delete process.env[key];
  }
};

describe('resolveProxyAgent', () => {
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    env = snapshotEnv();
  });

  afterEach(() => {
    restoreEnv(env);
  });

  it('falls back from WSS_PROXY to HTTPS_PROXY for wss:// targets', () => {
    clearProxyEnv();

    process.env.HTTPS_PROXY = 'http://proxy.example.com:8080';

    const resolved = resolveProxyAgent('wss://example.com/ws/workspaces/workspace?token=secret');
    expect(resolved.agent).toBeDefined();
    expect(resolved.proxyUrlRedacted).toBe('http://proxy.example.com:8080');
  });

  it('falls back from WS_PROXY to HTTP_PROXY for ws:// targets', () => {
    clearProxyEnv();

    process.env.HTTP_PROXY = 'http://proxy.example.com:8080';

    const resolved = resolveProxyAgent('ws://example.com:8787/api/workspaces/workspace');
    expect(resolved.agent).toBeDefined();
    expect(resolved.proxyUrlRedacted).toBe('http://proxy.example.com:8080');
  });

  it('respects NO_PROXY for websocket targets', () => {
    clearProxyEnv();

    process.env.HTTPS_PROXY = 'http://proxy.example.com:8080';
    process.env.NO_PROXY = 'example.com';

    const resolved = resolveProxyAgent('wss://example.com/ws/workspaces/workspace');
    expect(resolved.agent).toBeUndefined();
  });

  it('returns the raw proxy URL for transport construction while redacting credentials for logs', () => {
    clearProxyEnv();

    process.env.HTTPS_PROXY = 'http://user:pass@proxy.example.com:8080';

    const resolved = resolveProxyUrl('https://api.example.com/ds/lody/workspace:s:session');
    expect(resolved.proxyUrl).toBe('http://user:pass@proxy.example.com:8080');
    expect(resolved.proxyUrlRedacted).toBe('http://[redacted]@proxy.example.com:8080');
  });

  it('ignores unsupported (socks) proxy schemes instead of crashing the transport', () => {
    clearProxyEnv();

    process.env.ALL_PROXY = 'socks5://127.0.0.1:1080';

    const resolved = resolveProxyUrl(
      'https://runtime.example.test/api/runtimes/claude-code/artifact'
    );
    expect(resolved.proxyUrl).toBeUndefined();

    // resolveProxyAgent must not throw when constructing the agent.
    expect(
      resolveProxyAgent('https://runtime.example.test/api/runtimes/claude-code/artifact').agent
    ).toBeUndefined();
  });

  it('ignores a non-http(s) scheme on the explicit websocket-proxy path', () => {
    clearProxyEnv();

    // proxy-from-env keys off the target protocol, so an explicit WS_PROXY yields a
    // `ws://` proxy URL that undici's ProxyAgent cannot use.
    process.env.WS_PROXY = '127.0.0.1:9000';

    const resolved = resolveProxyUrl('ws://example.com/ws/workspaces/workspace');
    expect(resolved.proxyUrl).toBeUndefined();
  });

  it('normalizes a scheme-less proxy value into an http(s) proxy URL', () => {
    clearProxyEnv();

    // proxy-from-env prepends the target scheme to a scheme-less proxy value.
    process.env.HTTPS_PROXY = 'proxy.corp.example:8080';

    const resolved = resolveProxyUrl('https://api.example.com/thing');
    expect(resolved.proxyUrl).toBe('https://proxy.corp.example:8080');
    expect(resolved.proxyUrlRedacted).toBe('https://proxy.corp.example:8080');
  });
});
