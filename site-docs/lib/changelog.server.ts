import { changelogEn, changelogZh } from '@site/.source/server';
import {
  normalizeChangelogEntries,
  type ChangelogEntry,
  type ChangelogLocale,
  type ChangelogSourceEntry,
} from './changelog';

function getRawChangelogEntries(locale: ChangelogLocale): ChangelogSourceEntry[] {
  return (locale === 'zh' ? changelogZh : changelogEn) as ChangelogSourceEntry[];
}

export function getChangelogEntries(locale: ChangelogLocale): ChangelogEntry[] {
  return normalizeChangelogEntries(locale, getRawChangelogEntries(locale));
}

export function getChangelogEntry(
  locale: ChangelogLocale,
  slug: string
): ChangelogEntry | undefined {
  return getChangelogEntries(locale).find((entry) => entry.slug === slug);
}

// Entries are sorted newest-first, so the preceding index is the newer release.
export function getAdjacentChangelogEntries(
  locale: ChangelogLocale,
  slug: string
): { newer?: ChangelogEntry; older?: ChangelogEntry } {
  const entries = getChangelogEntries(locale);
  const index = entries.findIndex((entry) => entry.slug === slug);
  if (index === -1) return {};
  return { newer: entries[index - 1], older: entries[index + 1] };
}
