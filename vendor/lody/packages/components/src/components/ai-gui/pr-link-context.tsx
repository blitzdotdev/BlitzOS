'use client';

import { createContext, useContext, useMemo } from 'react';

export interface PrLinkContextValue {
  /** Canonical PR URL to match against outgoing hyperlinks. */
  prUrl: string;
  /** Callback to invoke when the user clicks a link that matches `prUrl`. */
  onOpenPrTab: () => void;
}

const PrLinkContext = createContext<PrLinkContextValue | null>(null);

function normalizePrUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

export function PrLinkProvider({
  prUrl,
  onOpenPrTab,
  children,
}: {
  prUrl?: string | null;
  onOpenPrTab?: () => void;
  children: React.ReactNode;
}) {
  const value = useMemo<PrLinkContextValue | null>(() => {
    if (!prUrl || !onOpenPrTab) return null;
    return { prUrl: normalizePrUrl(prUrl), onOpenPrTab };
  }, [onOpenPrTab, prUrl]);
  return <PrLinkContext.Provider value={value}>{children}</PrLinkContext.Provider>;
}

/**
 * Returns a handler for the supplied href if it points at the active session's
 * Pull Request URL, otherwise returns `null`. Consumers typically call the
 * handler from a link `onClick`, preventing the default external navigation.
 */
export function usePrLinkInterceptor(href: string | undefined): (() => void) | null {
  const ctx = useContext(PrLinkContext);
  if (!ctx || !href) return null;
  const normalized = normalizePrUrl(href);
  if (normalized === ctx.prUrl) return ctx.onOpenPrTab;
  return null;
}
