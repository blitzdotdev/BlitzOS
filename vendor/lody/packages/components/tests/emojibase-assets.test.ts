// @vitest-environment jsdom

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { buildEmojibaseAssets } from '../vite-emojibase-assets';
import { getBundledEmojibaseUrl, resolveEmojibaseLocale } from '../src/lib/emojibase-assets';

describe('bundled emojibase assets', () => {
  it('emits exactly the files the picker asks for, per product language', () => {
    expect(buildEmojibaseAssets().map((asset) => asset.fileName)).toEqual([
      'emojibase/en/data.json',
      'emojibase/en/messages.json',
      'emojibase/zh/data.json',
      'emojibase/zh/messages.json',
    ]);
  });

  it('resolves every source file out of the installed package', async () => {
    // The URL contract is only as good as the files behind it: a renamed or
    // missing dataset would otherwise surface as an empty picker at runtime.
    for (const asset of buildEmojibaseAssets()) {
      const contents = await readFile(asset.sourcePath, 'utf8');
      expect(JSON.parse(contents)).toBeTruthy();
    }
  });

  it('maps a product language onto a bundled locale, never an unbundled one', () => {
    expect(resolveEmojibaseLocale('en')).toBe('en');
    expect(resolveEmojibaseLocale('zh_CN')).toBe('zh');
    expect(resolveEmojibaseLocale('zh-Hans')).toBe('zh');
    // A language the picker has no bundled dataset for reads the English one
    // rather than requesting a file that was never emitted.
    expect(resolveEmojibaseLocale('ja')).toBe('en');
    expect(resolveEmojibaseLocale(undefined)).toBe('en');
  });

  it('anchors the dataset URL on the app root, not on the current route', () => {
    // The router uses browser history over http, so the document URL is a deep
    // route. Resolving against it asked for `…/settings/emojibase`, which the
    // dev server answered with the SPA fallback — the picker then parsed HTML
    // as JSON and gave up.
    window.history.pushState({}, '', '/acme/settings/agent-roles');
    expect(getBundledEmojibaseUrl()).toBe(`${window.location.origin}/emojibase`);

    window.history.pushState({}, '', '/');
    expect(getBundledEmojibaseUrl()).toBe(`${window.location.origin}/emojibase`);
  });
});
