import { describe, expect, it } from 'vitest';
import { resolveCliHttpTransportConfig } from './http-transport';

const envOf = (values: Record<string, string | undefined>): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
};

describe('resolveCliHttpTransportConfig', () => {
  it('enables the custom dispatcher and uses HTTP/1 by default', () => {
    const config = resolveCliHttpTransportConfig(envOf({}));

    expect(config.enabled).toBe(true);
    expect(config.allowH2).toBe(false);
    expect(config.connectTimeoutMs).toBe(15_000);
    expect(config.maxConcurrentStreams).toBe(100);
    expect(config.proxyEnvPresent).toBe(false);
  });

  it('allows HTTP/2 to be enabled without disabling proxy-aware transport', () => {
    const config = resolveCliHttpTransportConfig(
      envOf({
        LODY_HTTP2: '1',
        HTTPS_PROXY: 'http://proxy.example.com:8080',
      })
    );

    expect(config.enabled).toBe(true);
    expect(config.allowH2).toBe(true);
    expect(config.proxyEnvPresent).toBe(true);
  });

  it('can fall back to the Node default dispatcher explicitly', () => {
    const config = resolveCliHttpTransportConfig(
      envOf({
        LODY_HTTP_TRANSPORT: 'default',
      })
    );

    expect(config.enabled).toBe(false);
  });

  it('parses bounded numeric tuning values and ignores invalid values', () => {
    const config = resolveCliHttpTransportConfig(
      envOf({
        LODY_HTTP_CONNECT_TIMEOUT_MS: '30000',
        LODY_HTTP2_MAX_CONCURRENT_STREAMS: '256',
      })
    );
    const fallbackConfig = resolveCliHttpTransportConfig(
      envOf({
        LODY_HTTP_CONNECT_TIMEOUT_MS: '-1',
        LODY_HTTP2_MAX_CONCURRENT_STREAMS: 'not-a-number',
      })
    );

    expect(config.connectTimeoutMs).toBe(30_000);
    expect(config.maxConcurrentStreams).toBe(256);
    expect(fallbackConfig.connectTimeoutMs).toBe(15_000);
    expect(fallbackConfig.maxConcurrentStreams).toBe(100);
  });
});
