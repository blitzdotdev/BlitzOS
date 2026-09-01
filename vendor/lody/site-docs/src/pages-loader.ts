import type { LegalPageEntry, LegalPageSlug, PageLocale } from '@site/lib/pages';
import { LEGAL_PAGE_SLUGS } from '@site/lib/pages';
import { createServerFn } from '@tanstack/react-start';
import { notFound } from '@tanstack/react-router';
import { staticFunctionMiddleware } from '@tanstack/start-static-server-functions';

type LegalPageInput = {
  locale: PageLocale;
  slug: LegalPageSlug;
};

function isLegalSlug(value: string): value is LegalPageSlug {
  return (LEGAL_PAGE_SLUGS as readonly string[]).includes(value);
}

export const loadLegalPageRoute = createServerFn({ method: 'GET' })
  .middleware([staticFunctionMiddleware])
  .validator((input: LegalPageInput) => {
    if (!isLegalSlug(input.slug)) {
      throw notFound();
    }
    return input;
  })
  .handler(async ({ data }): Promise<LegalPageEntry> => {
    const { getLegalPage } = await import('@site/lib/pages.server');
    const entry = getLegalPage(data.locale, data.slug);
    if (!entry) throw notFound();
    return entry;
  });
