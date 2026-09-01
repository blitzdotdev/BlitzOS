import { describe, expect, it } from 'vitest';
import { formatLogArgs, summarizeLogValue, truncateLogText } from './log-format';

describe('truncateLogText', () => {
  it('keeps both the head and tail of oversized text', () => {
    const value = `head-${'x'.repeat(1200)}-tail`;
    const truncated = truncateLogText(value, { maxChars: 200, headChars: 80, tailChars: 40 });

    expect(truncated).toContain('head-');
    expect(truncated).toContain('-tail');
    expect(truncated).toContain('[truncated');
  });
});

describe('summarizeLogValue', () => {
  it('limits deep objects and wide arrays', () => {
    const wideObject = {
      a: 1,
      b: 2,
      c: 3,
      d: 4,
      e: 5,
      f: 6,
      g: 7,
      h: 8,
      i: 9,
      j: 10,
      k: 11,
      l: 12,
      m: 13,
      n: 14,
      o: 15,
      p: 16,
      q: 17,
      r: 18,
      s: 19,
      t: 20,
      u: 21,
      v: 22,
    };
    const wideArray = Array.from({ length: 30 }, (_, index) => index);
    const deepObject = {
      nested: {
        level1: {
          level2: {
            level3: {
              level4: {
                level5: 'too deep',
              },
            },
          },
        },
      },
    };

    const summarizedObject = summarizeLogValue(wideObject) as Record<string, unknown>;
    const summarizedArray = summarizeLogValue(wideArray) as unknown[];
    const summarizedDeepObject = summarizeLogValue(deepObject);

    expect(summarizedObject.__truncatedKeys).toBeDefined();
    expect(summarizedArray.at(-1)).toBe('[+10 more items]');
    expect(JSON.stringify(summarizedDeepObject)).not.toContain('too deep');
  });

  it('marks circular references instead of recursing forever', () => {
    const value: Record<string, unknown> = { ok: true };
    value.self = value;

    expect(summarizeLogValue(value)).toEqual({
      ok: true,
      self: '[Circular]',
    });
  });
});

describe('formatLogArgs', () => {
  it('caps extremely long final log messages', () => {
    const message = formatLogArgs('stderr', 'x'.repeat(9000));

    expect(message).toContain('stderr');
    expect(message).toContain('[truncated');
    expect(message.length).toBeLessThan(6500);
  });

  it('preserves error stack information', () => {
    const error = new Error('boom');
    const message = formatLogArgs('failed:', error);

    expect(message).toContain('failed:');
    expect(message).toContain('Error: boom');
    expect(message).toContain('at ');
  });
});
