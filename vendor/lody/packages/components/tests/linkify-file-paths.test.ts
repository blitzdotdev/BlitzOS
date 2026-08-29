import { describe, expect, it } from 'vitest';
import {
  matchWholeFilePath,
  splitTextIntoFilePathSegments,
} from '../src/lib/linkify-file-paths';

const paths = (value: string): string[] =>
  splitTextIntoFilePathSegments(value)
    .filter((segment) => segment.type === 'path')
    .map((segment) => segment.value);

describe('splitTextIntoFilePathSegments (prose)', () => {
  it('linkifies the requested bare-path forms', () => {
    expect(paths('see packages/components/src/lib/session-file-language.ts here')).toEqual([
      'packages/components/src/lib/session-file-language.ts',
    ]);
    expect(paths('open packages/components/src/lib/session-file-language.ts:32 now')).toEqual([
      'packages/components/src/lib/session-file-language.ts:32',
    ]);
    expect(paths('jump to locale/session-file-language.ts:L32 please')).toEqual([
      'locale/session-file-language.ts:L32',
    ]);
    expect(paths('and README.md#L100 too')).toEqual(['README.md#L100']);
  });

  it('preserves surrounding text and order', () => {
    const segments = splitTextIntoFilePathSegments('edit src/a.ts then src/b.ts done');
    expect(segments).toEqual([
      { type: 'text', value: 'edit ' },
      { type: 'path', value: 'src/a.ts' },
      { type: 'text', value: ' then ' },
      { type: 'path', value: 'src/b.ts' },
      { type: 'text', value: ' done' },
    ]);
  });

  it('strips trailing sentence/bracket punctuation but keeps line suffixes', () => {
    expect(paths('look at src/foo.ts.')).toEqual(['src/foo.ts']);
    expect(paths('(see src/foo.ts:32)')).toEqual(['src/foo.ts:32']);
    expect(paths('"src/foo.ts", really')).toEqual(['src/foo.ts']);
  });

  it('works inside CJK prose without spaces', () => {
    expect(paths('详见packages/components/src/lib/foo.ts。')).toEqual([
      'packages/components/src/lib/foo.ts',
    ]);
  });

  it('requires a slash or line suffix in prose', () => {
    expect(paths('we run Node.js in production')).toEqual([]);
    expect(paths('bump to version 2.0 today')).toEqual([]);
    expect(paths('the index.js file is large')).toEqual([]);
  });

  it('does not linkify non-path slash usage', () => {
    expect(paths('this and/or that')).toEqual([]);
    expect(paths('a ratio of 3/4 here')).toEqual([]);
    expect(paths('read/write access')).toEqual([]);
  });

  it('leaves real URLs and emails alone', () => {
    expect(paths('mail me at user@example.com/inbox now')).toEqual([]);
    expect(paths('visit example.com/page.html for docs')).toEqual([]);
  });

  it('does not touch plain text with no candidates', () => {
    expect(splitTextIntoFilePathSegments('just a normal sentence.')).toEqual([
      { type: 'text', value: 'just a normal sentence.' },
    ]);
  });
});

describe('matchWholeFilePath (inline code)', () => {
  it('matches when the whole content is a file path', () => {
    expect(matchWholeFilePath('locale/session-file-language.ts')).toBe(
      'locale/session-file-language.ts'
    );
    expect(matchWholeFilePath('src/foo.ts:32')).toBe('src/foo.ts:32');
    expect(matchWholeFilePath('tsconfig.json')).toBe('tsconfig.json');
    expect(matchWholeFilePath('README.md')).toBe('README.md');
  });

  it('rejects commands, identifiers, and unrecognized bare names', () => {
    expect(matchWholeFilePath('npm run build')).toBeNull();
    expect(matchWholeFilePath('useState')).toBeNull();
    expect(matchWholeFilePath('Math.max')).toBeNull();
    expect(matchWholeFilePath('foo.bar')).toBeNull();
  });
});
