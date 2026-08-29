// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectBrowserLanguage } from '../src/i18n';

type GlobalWindow = typeof window & { __LODY_ELECTRON__?: boolean };

afterEach(() => {
  vi.unstubAllGlobals();
  const w = window as GlobalWindow;
  delete w.__LODY_ELECTRON__;
});

function setLanguages(languages: string[] | undefined, language?: string) {
  // jsdom provides navigator.language by default; replace it per test.
  Object.defineProperty(navigator, 'languages', {
    configurable: true,
    value: languages,
  });
  if (language !== undefined) {
    Object.defineProperty(navigator, 'language', {
      configurable: true,
      value: language,
    });
  }
}

describe('detectBrowserLanguage', () => {
  it('returns zh_CN for an explicit zh-CN navigator.languages entry', () => {
    setLanguages(['zh-CN', 'en-US'], 'zh-CN');
    expect(detectBrowserLanguage()).toBe('zh_CN');
  });

  it('returns en for a non-Chinese navigator.languages list', () => {
    setLanguages(['en-US', 'fr-FR'], 'en-US');
    expect(detectBrowserLanguage()).toBe('en');
  });

  // Regression: an English-primary browser with Chinese as a secondary fallback
  // used to walk past `en-US` (which the old code normalized to `en_US` — not a
  // supported key) and incorrectly resolve to `zh_CN`. The fix matches the BCP-47
  // base subtag, so the first supported base wins.
  it('prefers the primary base subtag over later fallbacks', () => {
    setLanguages(['en-US', 'zh-CN'], 'en-US');
    expect(detectBrowserLanguage()).toBe('en');
  });

  it('treats any Chinese variant as zh_CN', () => {
    setLanguages(['zh-Hant-HK'], 'zh-Hant-HK');
    expect(detectBrowserLanguage()).toBe('zh_CN');

    setLanguages(['zh'], 'zh');
    expect(detectBrowserLanguage()).toBe('zh_CN');
  });

  it('matches BCP-47 base subtags for any region (en-GB, en-AU, en, ...)', () => {
    for (const tag of ['en', 'en-GB', 'en-AU', 'en-us', 'EN-US']) {
      setLanguages([tag], tag);
      expect(detectBrowserLanguage(), `tag=${tag}`).toBe('en');
    }
  });

  // Regression: BCP-47 is case-insensitive. Older code compared the tag
  // case-sensitively, so `ZH-CN` or `EN-US` would fall through to `en` even
  // when the user prefers Chinese. The detector now lowercases before matching.
  it('matches BCP-47 tags case-insensitively', () => {
    setLanguages(['ZH-CN'], 'ZH-CN');
    expect(detectBrowserLanguage()).toBe('zh_CN');

    setLanguages(['EN-US'], 'EN-US');
    expect(detectBrowserLanguage()).toBe('en');
  });

  it('walks the languages list in order', () => {
    setLanguages(['fr-FR', 'zh-CN', 'en-US'], 'fr-FR');
    expect(detectBrowserLanguage()).toBe('zh_CN');
  });

  it('returns null when no language matches a supported locale', () => {
    setLanguages(['fr-FR', 'de-DE'], 'fr-FR');
    expect(detectBrowserLanguage()).toBeNull();
  });

  it('falls back to navigator.language when navigator.languages is empty', () => {
    setLanguages([], 'zh-CN');
    expect(detectBrowserLanguage()).toBe('zh_CN');
  });

  it('returns null in the Electron shell', () => {
    setLanguages(['zh-CN'], 'zh-CN');
    (window as GlobalWindow).__LODY_ELECTRON__ = true;
    expect(detectBrowserLanguage()).toBeNull();
  });
});
