import { blogEn, blogZh } from '@site/.source/server';
import {
  normalizeBlogEntries,
  type BlogEntry,
  type BlogLocale,
  type BlogSourceEntry,
} from './blog';

function getRawBlogEntries(locale: BlogLocale): BlogSourceEntry[] {
  return (locale === 'zh' ? blogZh : blogEn) as BlogSourceEntry[];
}

export function getBlogEntries(locale: BlogLocale): BlogEntry[] {
  return normalizeBlogEntries(locale, getRawBlogEntries(locale));
}

export function getBlogEntry(
  locale: BlogLocale,
  slugSegments: string[] | string
): BlogEntry | undefined {
  const slug = Array.isArray(slugSegments) ? slugSegments.join('/') : slugSegments;
  return getBlogEntries(locale).find((entry) => entry.slug === slug);
}
