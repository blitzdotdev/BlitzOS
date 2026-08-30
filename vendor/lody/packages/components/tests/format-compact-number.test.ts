import { describe, expect, it } from 'vitest';
import { formatCompactNumber, formatUsdAmount } from '../src/lib/format-compact-number';
import { toIntlLocaleOrEn } from '../src/lib/intl-locale';

describe('toIntlLocaleOrEn', () => {
  it('maps product language tags and falls back to English', () => {
    expect(toIntlLocaleOrEn('en')).toBe('en');
    expect(toIntlLocaleOrEn('zh_CN')).toBe('zh-CN');
    expect(toIntlLocaleOrEn(undefined)).toBe('en');
    expect(toIntlLocaleOrEn(null)).toBe('en');
  });
});

describe('formatCompactNumber', () => {
  it('uses English compact units for English locales', () => {
    expect(formatCompactNumber(1_200, 'en')).toBe('1.2K');
    expect(formatCompactNumber(1_200_000, 'en')).toBe('1.2M');
    expect(formatCompactNumber(100_000_000, 'en')).toBe('100M');
    expect(formatCompactNumber(1_200_000_000, 'en')).toBe('1.2B');
  });

  it('uses Chinese compact units for zh-CN', () => {
    expect(formatCompactNumber(15_000, 'zh-CN')).toBe('1.5万');
    expect(formatCompactNumber(100_000_000, 'zh-CN')).toBe('1亿');
    expect(formatCompactNumber(1_200_000_000, 'zh-CN')).toBe('12亿');
  });

  it('does not fall back to the host OS locale when locale is omitted', () => {
    // Defaulting to English prevents Chinese units from leaking into English UI
    // on zh-CN systems when a caller forgets to pass the product language.
    expect(formatCompactNumber(100_000_000, undefined)).toBe('100M');
    expect(formatCompactNumber(100_000_000, null)).toBe('100M');
  });
});

describe('formatUsdAmount', () => {
  it('formats USD with locale-aware grouping', () => {
    expect(formatUsdAmount(1234.5, 'en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })).toBe(
      '$1,234.50'
    );
  });

  it('keeps sub-cent precision for tiny daily costs', () => {
    expect(formatUsdAmount(0.004, 'en')).toBe('$0.004');
  });
});
