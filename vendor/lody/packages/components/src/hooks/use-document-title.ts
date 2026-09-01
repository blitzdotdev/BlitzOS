import { useEffect } from 'react';

const DEFAULT_TITLE = 'Lody';

/**
 * Hook to manage document title.
 * Automatically restores the default title when component unmounts.
 */
export function useDocumentTitle(title: string | null | undefined) {
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;

    const previousTitle = document.title;
    document.title = title ? `${title} - ${DEFAULT_TITLE}` : DEFAULT_TITLE;

    return () => {
      document.title = previousTitle;
    };
  }, [title]);
}
