import { describe, expect, it } from 'vitest';

import {
  arePersistedMentionRangesEqual,
  sanitizeMentionRanges,
  toPersistedMentionRanges,
} from '../src/components/mentions/mention-persistence';

const TEXT = 'see @src/a.ts and #482';

describe('toPersistedMentionRanges', () => {
  it('keeps only the four fields that survive a reload', () => {
    expect(
      toPersistedMentionRanges([
        {
          start: 4,
          end: 13,
          value: 'src/a.ts',
          kind: 'file',
          // A live range carries callbacks. `JSON.stringify` writes `{}` for
          // them, so storing the object whole reads back something shaped like
          // a range with a dead handler on it.
          onMentionSelect: () => undefined,
        } as Parameters<typeof toPersistedMentionRanges>[0][number],
      ])
    ).toEqual([{ start: 4, end: 13, value: 'src/a.ts', kind: 'file' }]);
  });

  it('drops pasted text, which the pasted-text drafts already own', () => {
    // Persisting both would let the two disagree the moment one is edited.
    expect(
      toPersistedMentionRanges([{ start: 0, end: 8, value: 'paste-1', kind: 'pasted_text' }])
    ).toEqual([]);
  });

  it('drops a range with no kind, which nothing downstream could dispatch on', () => {
    expect(toPersistedMentionRanges([{ start: 0, end: 4, value: 'x' }])).toEqual([]);
  });
});

describe('sanitizeMentionRanges', () => {
  const file = { start: 4, end: 13, value: 'src/a.ts', kind: 'file' };
  const issue = { start: 18, end: 22, value: '#482', kind: 'issue' };

  it('restores ranges that still fit the text', () => {
    expect(sanitizeMentionRanges(TEXT, [issue, file])).toEqual([file, issue]);
  });

  it('drops a range whose offsets no longer fit, rather than clamping it', () => {
    // Stored against text that has since been edited elsewhere. Decorating the
    // wrong characters is worse than decorating none.
    expect(sanitizeMentionRanges('short', [file])).toEqual([]);
  });

  it('rejects malformed stored state instead of trusting it', () => {
    expect(
      sanitizeMentionRanges(TEXT, [
        { ...file, start: 1.5 },
        { ...file, end: 2 },
        { ...file, value: '' },
        { ...file, kind: '' },
        'not an object',
        null,
        issue,
      ])
    ).toEqual([issue]);
  });

  it('drops the later of two overlapping ranges', () => {
    expect(sanitizeMentionRanges(TEXT, [file, { ...issue, start: 8 }])).toEqual([file]);
  });

  it('returns nothing for absent or empty state', () => {
    expect(sanitizeMentionRanges(TEXT, undefined)).toEqual([]);
    expect(sanitizeMentionRanges(TEXT, [])).toEqual([]);
  });
});

describe('arePersistedMentionRangesEqual', () => {
  const range = { start: 4, end: 13, value: 'src/a.ts', kind: 'file' };

  it('spares the draft a localStorage write when nothing moved', () => {
    expect(arePersistedMentionRangesEqual([range], [{ ...range }])).toBe(true);
  });

  it('notices a shifted range, which is what typing before a mention does', () => {
    expect(arePersistedMentionRangesEqual([range], [{ ...range, start: 5, end: 14 }])).toBe(false);
  });

  it('notices an added or removed range', () => {
    expect(arePersistedMentionRangesEqual([range], [])).toBe(false);
    expect(arePersistedMentionRangesEqual([], [range])).toBe(false);
  });
});
