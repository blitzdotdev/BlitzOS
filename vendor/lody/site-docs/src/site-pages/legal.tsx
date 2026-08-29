import { LegalPage } from '@site/components/legal-page';
import type { LegalPageEntry, PageLocale } from '@site/lib/pages';
import { pageHead } from '@site/lib/metadata';
import type { SiteHead } from '@site/lib/metadata';
import { localeCode } from './shared';

export function legalPageHead(locale: PageLocale, entry: LegalPageEntry): SiteHead {
  const enPath = `/${entry.slug}`;
  const zhPath = `/zh/${entry.slug}`;

  return pageHead({
    title: entry.title,
    description: entry.description,
    path: entry.url,
    locale: localeCode(locale),
    alternates: [
      { lang: 'en-US', path: enPath },
      { lang: 'zh-CN', path: zhPath },
    ],
  });
}

export function LegalRoutePage({
  entry,
  locale,
}: {
  entry: LegalPageEntry;
  locale: PageLocale;
}) {
  return <LegalPage entry={entry} locale={locale} />;
}
