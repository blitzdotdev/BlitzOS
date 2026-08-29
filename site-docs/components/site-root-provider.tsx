import { useLocation, useNavigate } from '@tanstack/react-router';
import { RootProvider } from 'fumadocs-ui/provider/tanstack';
import type { ReactNode } from 'react';

import { MarketingAtmosphereHost } from './marketing-atmosphere';

type SiteLocale = 'en' | 'zh';

const locales = [
  { locale: 'en', name: 'English' },
  { locale: 'zh', name: '简体中文' },
];

const zhTranslations = {
  chooseLanguage: '选择语言',
  toc: '本页目录',
};

function getCurrentLocale(pathname: string): SiteLocale {
  return pathname === '/zh' || pathname.startsWith('/zh/') ? 'zh' : 'en';
}

function normalizePath(pathname: string) {
  return pathname.replace(/\/$/u, '') || '/';
}

function getLocalizedPath(pathname: string, targetLocale: string) {
  const cleanPath = normalizePath(pathname);

  if (targetLocale === 'zh') {
    if (cleanPath === '/') return '/zh';
    if (cleanPath === '/zh' || cleanPath.startsWith('/zh/')) return cleanPath;
    return `/zh${cleanPath}`;
  }

  if (cleanPath === '/zh') return '/';
  if (cleanPath.startsWith('/zh/')) return cleanPath.replace(/^\/zh/u, '') || '/';
  return cleanPath;
}

export function SiteRootProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const pathname = location.pathname;
  const locale = getCurrentLocale(pathname);

  return (
    <RootProvider
      theme={{ defaultTheme: 'dark', disableTransitionOnChange: false }}
      i18n={{
        locale,
        locales,
        translations: locale === 'zh' ? zhTranslations : undefined,
        onLocaleChange: (targetLocale) => {
          void navigate({ to: getLocalizedPath(pathname, targetLocale) as never });
        },
      }}
    >
      {/* Shared WebGL field for price / download / changelog — one compile per session. */}
      <MarketingAtmosphereHost />
      {children}
    </RootProvider>
  );
}
