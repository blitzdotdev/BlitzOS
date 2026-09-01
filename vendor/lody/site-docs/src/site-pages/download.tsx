import { DownloadPage } from '@site/components/download-page';
import { pageHead } from '@site/lib/metadata';
import type { SiteHead } from '@site/lib/metadata';
import { localeCode, type SiteLocale } from './shared';

export function downloadHead(locale: SiteLocale): SiteHead {
  return pageHead({
    title: locale === 'zh' ? '下载 Lody' : 'Download Lody',
    description:
      locale === 'zh'
        ? '下载 Lody 桌面端、移动端客户端，或打开浏览器版本。'
        : 'Download Lody clients for desktop, mobile, and browser access.',
    path: locale === 'zh' ? '/zh/download' : '/download',
    locale: localeCode(locale),
    alternates: [
      { lang: 'en-US', path: '/download' },
      { lang: 'zh-CN', path: '/zh/download' },
    ],
  });
}

export function DownloadRoutePage({ locale }: { locale: SiteLocale }) {
  return <DownloadPage locale={locale} />;
}
