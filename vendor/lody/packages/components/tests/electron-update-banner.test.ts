import { describe, expect, it } from 'vitest';
import type { ElectronUpdaterState } from '@lody/shared';
import {
  pickLocalizedReleaseNotes,
  readUpdateBannerState,
} from '../src/lib/electron-update-banner';

function state(overrides: Partial<ElectronUpdaterState>): ElectronUpdaterState {
  return { phase: 'idle', currentVersion: '1.0.0', ...overrides };
}

describe('readUpdateBannerState', () => {
  it('returns null without an updater snapshot', () => {
    expect(readUpdateBannerState(null)).toBeNull();
  });

  it.each(['idle', 'checking', 'up_to_date', 'error', 'disabled'] as const)(
    'stays silent in the %s phase',
    (phase) => {
      expect(readUpdateBannerState(state({ phase, availableVersion: '1.1.0' }))).toBeNull();
    }
  );

  it('reports a download in progress with rounded percent', () => {
    expect(
      readUpdateBannerState(
        state({ phase: 'downloading', availableVersion: '1.1.0', percent: 42.6 })
      )
    ).toEqual({ stage: 'downloading', version: '1.1.0', percent: 43 });
  });

  it('reports an indeterminate download when the feed has no percent', () => {
    expect(
      readUpdateBannerState(state({ phase: 'downloading', availableVersion: '1.1.0' }))
    ).toEqual({ stage: 'downloading', version: '1.1.0', percent: null });
  });

  it('clamps an out-of-range percent', () => {
    expect(
      readUpdateBannerState(
        state({ phase: 'downloading', availableVersion: '1.1.0', percent: 140 })
      )?.percent
    ).toBe(100);
    expect(
      readUpdateBannerState(state({ phase: 'downloading', availableVersion: '1.1.0', percent: -5 }))
        ?.percent
    ).toBe(0);
  });

  it('prefers the downloaded version once the download finishes', () => {
    expect(
      readUpdateBannerState(
        state({
          phase: 'downloaded',
          availableVersion: '1.1.0',
          downloadedVersion: '1.1.1',
          percent: 100,
        })
      )
    ).toEqual({ stage: 'downloaded', version: '1.1.1', percent: null });
  });

  it('falls back to the available version when only that one is reported', () => {
    expect(
      readUpdateBannerState(state({ phase: 'downloaded', availableVersion: '1.1.0' }))
    ).toEqual({ stage: 'downloaded', version: '1.1.0', percent: null });
  });

  it('stays silent when no version is known', () => {
    expect(
      readUpdateBannerState(state({ phase: 'downloading', availableVersion: '   ' }))
    ).toBeNull();
  });
});

describe('pickLocalizedReleaseNotes', () => {
  const notes = state({
    phase: 'downloaded',
    downloadedVersion: '1.1.0',
    releaseNotes: 'publisher notes',
    releaseNotesByLocale: { en: 'English notes', zh_CN: '中文说明' },
  });

  it('picks the notes for the active language', () => {
    expect(pickLocalizedReleaseNotes(notes, 'zh_CN')).toBe('中文说明');
    expect(pickLocalizedReleaseNotes(notes, 'en')).toBe('English notes');
  });

  it('treats any Chinese tag as Simplified Chinese', () => {
    expect(pickLocalizedReleaseNotes(notes, 'zh-TW')).toBe('中文说明');
  });

  it('falls back to English when the active language has no notes', () => {
    const enOnly = state({ releaseNotesByLocale: { en: 'English notes' } });
    expect(pickLocalizedReleaseNotes(enOnly, 'zh_CN')).toBe('English notes');
  });

  it('falls back to the publisher notes when no localized notes exist', () => {
    expect(pickLocalizedReleaseNotes(state({ releaseNotes: 'publisher notes' }), 'zh_CN')).toBe(
      'publisher notes'
    );
  });

  it('ignores blank notes and reports nothing to render', () => {
    expect(
      pickLocalizedReleaseNotes(
        state({ releaseNotes: '  \n ', releaseNotesByLocale: { en: '' } }),
        'en'
      )
    ).toBeNull();
    expect(pickLocalizedReleaseNotes(null, 'en')).toBeNull();
  });
});
