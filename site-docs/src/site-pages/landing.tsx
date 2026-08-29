import { LandingPage } from '@site/components/landing';
import {
  landingJsonLd,
  landingMetaDescription,
  landingPageTitle,
} from '@site/lib/landing-seo';
import { pageHead } from '@site/lib/metadata';
import type { SiteHead } from '@site/lib/metadata';
import { localeCode, type SiteLocale } from './shared';

const landingAlternates = [
  { lang: 'en-US' as const, path: '/' },
  { lang: 'zh-CN' as const, path: '/zh' },
];

export function landingHead(locale: SiteLocale, options?: { noindex?: boolean }): SiteHead {
  return pageHead({
    title: landingPageTitle(locale),
    description: landingMetaDescription(locale),
    path: locale === 'zh' ? '/zh' : '/',
    locale: localeCode(locale),
    alternates: landingAlternates,
    robots: options?.noindex ? { index: false, follow: true } : undefined,
    jsonLd: landingJsonLd(locale),
  });
}

export function LandingRoutePage({ locale }: { locale: SiteLocale }) {
  return <LandingPage locale={locale} />;
}
