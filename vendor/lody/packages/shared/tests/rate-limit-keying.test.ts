import { describe, expect, it } from 'vitest';

import {
  getRateLimitEntryKey,
  parseRateLimitEntryKey,
  CODEX_SPARK_LIMIT_ID,
} from '../src/schema';

describe('rate limit entry key helpers', () => {
  it('builds keys using limitId', () => {
    expect(getRateLimitEntryKey('codex', 'codex')).toBe('codex::codex');
    expect(getRateLimitEntryKey('codex', CODEX_SPARK_LIMIT_ID)).toBe('codex::codex_bengalfox');
    expect(getRateLimitEntryKey('claude', 'claude')).toBe('claude::claude');
  });

  it('falls back to cliType when limitId is absent', () => {
    expect(getRateLimitEntryKey('codex', null)).toBe('codex::codex');
    expect(getRateLimitEntryKey('codex', '')).toBe('codex::codex');
    expect(getRateLimitEntryKey('codex', '   ')).toBe('codex::codex');
  });

  it('parses legacy keys (no separator)', () => {
    expect(parseRateLimitEntryKey('codex')).toEqual({
      cliType: 'codex',
      limitId: null,
    });
  });

  it('parses composite keys', () => {
    expect(parseRateLimitEntryKey('codex::codex')).toEqual({
      cliType: 'codex',
      limitId: 'codex',
    });

    expect(parseRateLimitEntryKey('codex::codex_bengalfox')).toEqual({
      cliType: 'codex',
      limitId: 'codex_bengalfox',
    });
  });

  it('round-trips limitId correctly', () => {
    const limitId = CODEX_SPARK_LIMIT_ID;
    const key = getRateLimitEntryKey('codex', limitId);
    const parsed = parseRateLimitEntryKey(key);
    expect(parsed.cliType).toBe('codex');
    expect(parsed.limitId).toBe(limitId);
  });
});
