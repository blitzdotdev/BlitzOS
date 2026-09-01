import { isNativeAppShell } from './native-platform';

const LEGAL_LINK_FALLBACK_ORIGIN = 'https://lody.ai';

function getConfiguredSiteOrigin(): string | null {
  const configuredSiteUrl = import.meta.env.VITE_SITE_URL?.trim();
  if (!configuredSiteUrl) {
    return null;
  }

  try {
    return new URL(configuredSiteUrl).origin;
  } catch {
    return null;
  }
}

function getLegalLinksOrigin(): string {
  const configuredSiteOrigin = getConfiguredSiteOrigin();
  if (configuredSiteOrigin) {
    return configuredSiteOrigin;
  }

  if (typeof window === 'undefined' || isNativeAppShell()) {
    return LEGAL_LINK_FALLBACK_ORIGIN;
  }

  if (window.location.protocol === 'file:' || window.location.origin === 'null') {
    return LEGAL_LINK_FALLBACK_ORIGIN;
  }

  return window.location.origin;
}

export function getAccountDeletionUrl(language: string | undefined): string {
  const isChinese = language?.startsWith('zh') ?? false;
  return new URL(
    isChinese ? '/zh/account-deletion' : '/account-deletion',
    getLegalLinksOrigin()
  ).toString();
}
