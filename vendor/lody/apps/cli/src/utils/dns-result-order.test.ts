import { describe, expect, it } from 'vitest';
import { resolveDnsResultOrder } from './dns-result-order';

const envOf = (values: Record<string, string | undefined>): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
};

describe('resolveDnsResultOrder', () => {
  it('defaults to ipv4first', () => {
    expect(resolveDnsResultOrder(envOf({}), [])).toEqual({
      order: 'ipv4first',
      reason: 'default',
    });
  });

  it('keeps the runtime order when --dns-result-order is passed via execArgv', () => {
    expect(resolveDnsResultOrder(envOf({}), ['--dns-result-order=verbatim'])).toEqual({
      order: null,
      reason: 'explicit-node-flag',
    });
  });

  it('keeps the runtime order when --dns-result-order is passed via NODE_OPTIONS', () => {
    expect(
      resolveDnsResultOrder(envOf({ NODE_OPTIONS: '--dns-result-order=ipv4first' }), [])
    ).toEqual({ order: null, reason: 'explicit-node-flag' });
  });

  it('honors LODY_DNS_RESULT_ORDER overrides', () => {
    expect(resolveDnsResultOrder(envOf({ LODY_DNS_RESULT_ORDER: 'ipv6first' }), [])).toEqual({
      order: 'ipv6first',
      reason: 'env',
    });
  });

  it('treats runtime-default values as a no-op', () => {
    for (const value of ['node', 'native', 'default', 'verbatim', 'VERBATIM']) {
      expect(resolveDnsResultOrder(envOf({ LODY_DNS_RESULT_ORDER: value }), [])).toEqual({
        order: null,
        reason: 'env-runtime-default',
      });
    }
  });

  it('falls back to ipv4first on invalid env values', () => {
    expect(resolveDnsResultOrder(envOf({ LODY_DNS_RESULT_ORDER: 'bogus' }), [])).toEqual({
      order: 'ipv4first',
      reason: 'env-invalid',
    });
  });
});
