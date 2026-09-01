import { pagesEn, pagesZh } from '@site/.source/server';
import {
  normalizeLegalPages,
  type LegalPageEntry,
  type LegalPageSlug,
  type PageLocale,
  type PageSourceEntry,
} from './pages';

function getRawPages(locale: PageLocale): PageSourceEntry[] {
  return (locale === 'zh' ? pagesZh : pagesEn) as PageSourceEntry[];
}

export function getLegalPages(locale: PageLocale): LegalPageEntry[] {
  return normalizeLegalPages(locale, getRawPages(locale));
}

export function getLegalPage(
  locale: PageLocale,
  slug: LegalPageSlug
): LegalPageEntry | undefined {
  return getLegalPages(locale).find((entry) => entry.slug === slug);
}
