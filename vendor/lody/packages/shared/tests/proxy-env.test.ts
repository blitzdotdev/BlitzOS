import { describe, expect, it } from 'vitest';
import {
  hasProxyEnvValue,
  mergeLoopbackNoProxy,
  withLoopbackNoProxy,
} from '../src/proxy-env';

describe('hasProxyEnvValue', () => {
  it('ignores present-but-empty proxy variables', () => {
    expect(hasProxyEnvValue({ HTTP_PROXY: '', ALL_PROXY: '   ' })).toBe(false);
  });

  it('detects any spelling', () => {
    expect(hasProxyEnvValue({ https_proxy: 'http://127.0.0.1:1087' })).toBe(true);
    expect(hasProxyEnvValue({ npm_config_proxy: 'http://127.0.0.1:1087' })).toBe(true);
  });
});

describe('mergeLoopbackNoProxy', () => {
  it('adds the loopback hosts when nothing is configured', () => {
    expect(mergeLoopbackNoProxy(undefined, undefined)).toBe('localhost,127.0.0.1,::1');
  });

  it('unions both spellings and preserves user entries first', () => {
    expect(mergeLoopbackNoProxy('corp.internal', 'localhost,vpn.internal')).toBe(
      'corp.internal,localhost,vpn.internal,127.0.0.1,::1'
    );
  });

  it('does not duplicate an entry that differs only in case', () => {
    expect(mergeLoopbackNoProxy('LocalHost', undefined)).toBe('LocalHost,127.0.0.1,::1');
  });

  it('collapses a wildcard bypass', () => {
    expect(mergeLoopbackNoProxy('', '*')).toBe('*');
  });
});

describe('withLoopbackNoProxy', () => {
  it('leaves an environment without a proxy untouched', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', NO_PROXY: '' };
    expect(withLoopbackNoProxy(env)).toBe(env);
  });

  it('excludes loopback when the uppercase spelling is empty', () => {
    // The reported Grok shape: `no_proxy` correct, `NO_PROXY` present but
    // empty. Rust reqwest reads the uppercase one first and proxies loopback.
    const env = withLoopbackNoProxy<NodeJS.ProcessEnv>({
      HTTP_PROXY: 'http://127.0.0.1:1087',
      no_proxy: 'localhost,127.0.0.1,::1',
      NO_PROXY: '',
    });
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,::1');
    expect(env.no_proxy).toBe('localhost,127.0.0.1,::1');
  });

  it('adds loopback when a proxy is set with no bypass at all', () => {
    const env = withLoopbackNoProxy<NodeJS.ProcessEnv>({ ALL_PROXY: 'socks5://127.0.0.1:1080' });
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,::1');
    expect(env.no_proxy).toBe('localhost,127.0.0.1,::1');
  });

  it('keeps a corporate bypass list and mirrors it to both spellings', () => {
    const env = withLoopbackNoProxy<NodeJS.ProcessEnv>({
      https_proxy: 'http://proxy.corp:8080',
      NO_PROXY: 'corp.internal',
    });
    expect(env.NO_PROXY).toBe('corp.internal,localhost,127.0.0.1,::1');
    expect(env.no_proxy).toBe('corp.internal,localhost,127.0.0.1,::1');
  });

  it('returns the same object when both spellings already agree', () => {
    const env: NodeJS.ProcessEnv = {
      HTTP_PROXY: 'http://127.0.0.1:1087',
      NO_PROXY: 'localhost,127.0.0.1,::1',
      no_proxy: 'localhost,127.0.0.1,::1',
    };
    expect(withLoopbackNoProxy(env)).toBe(env);
  });

  it('does not mutate its input', () => {
    const env: NodeJS.ProcessEnv = { HTTP_PROXY: 'http://127.0.0.1:1087' };
    withLoopbackNoProxy(env);
    expect(env.NO_PROXY).toBeUndefined();
  });
});
