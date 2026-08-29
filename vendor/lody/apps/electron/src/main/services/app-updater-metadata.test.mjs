import assert from 'node:assert/strict'
import test from 'node:test'
import { readUpdaterReleaseMetadata } from './app-updater-metadata.ts'

void test('reads standard and localized release notes from update metadata', () => {
  assert.deepEqual(
    readUpdaterReleaseMetadata(
      {
        releaseName: 'Lody 1.2.3',
        releaseDate: '2026-08-10',
        releaseNotes: 'English fallback',
        vendor: {
          lodyChangelog: {
            contentVersion: '1.2.3',
            locales: {
              en: 'English notes',
              zh_CN: '中文更新内容'
            }
          }
        }
      },
      '1.2.3'
    ),
    {
      releaseName: 'Lody 1.2.3',
      releaseDate: '2026-08-10',
      releaseNotes: 'English fallback',
      releaseNotesByLocale: {
        en: 'English notes',
        zh_CN: '中文更新内容'
      }
    }
  )
})

void test('keeps compatibility with array-shaped release notes', () => {
  assert.deepEqual(
    readUpdaterReleaseMetadata(
      {
        releaseNotes: [{ version: '1.2.3', note: 'Newest release' }]
      },
      '1.2.3'
    ),
    {
      releaseName: undefined,
      releaseDate: undefined,
      releaseNotes: 'Newest release',
      releaseNotesByLocale: undefined
    }
  )
})

void test('ignores malformed, empty, and oversized remote metadata', () => {
  assert.deepEqual(
    readUpdaterReleaseMetadata(
      {
        releaseName: [],
        releaseDate: '   ',
        releaseNotes: 'x'.repeat(64 * 1024 + 1),
        vendor: {
          lodyChangelog: {
            contentVersion: '1.2.3',
            locales: { en: 42, zh_CN: '' }
          }
        }
      },
      '1.2.3'
    ),
    {
      releaseName: undefined,
      releaseDate: undefined,
      releaseNotes: undefined,
      releaseNotesByLocale: undefined
    }
  )
})

void test('rejects localized notes whose content version does not match the update', () => {
  assert.deepEqual(
    readUpdaterReleaseMetadata(
      {
        releaseNotes: 'Standard fallback',
        vendor: {
          lodyChangelog: {
            contentVersion: '1.2.2',
            locales: { en: 'Stale localized notes', zh_CN: '过期说明' }
          }
        }
      },
      '1.2.3'
    ),
    {
      releaseName: undefined,
      releaseDate: undefined,
      releaseNotes: 'Standard fallback',
      releaseNotesByLocale: undefined
    }
  )
})
