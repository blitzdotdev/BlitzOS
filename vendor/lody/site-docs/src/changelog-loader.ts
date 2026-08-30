import type { ChangelogEntry, ChangelogLocale } from '@site/lib/changelog';
import type { ChangelogPostRouteData } from '@site/src/site-pages/shared';
import { createServerFn } from '@tanstack/react-start';
import { notFound } from '@tanstack/react-router';
import { staticFunctionMiddleware } from '@tanstack/start-static-server-functions';

type ChangelogLocaleInput = {
  locale: ChangelogLocale;
};

type ChangelogPostInput = ChangelogLocaleInput & {
  slug: string;
};

export const loadChangelogIndexRoute = createServerFn({ method: 'GET' })
  .middleware([staticFunctionMiddleware])
  .validator((input: ChangelogLocaleInput) => input)
  .handler(async ({ data }): Promise<ChangelogEntry[]> => {
    const { getChangelogEntries } = await import('@site/lib/changelog.server');

    return getChangelogEntries(data.locale);
  });

export const loadChangelogPostRoute = createServerFn({ method: 'GET' })
  .middleware([staticFunctionMiddleware])
  .validator((input: ChangelogPostInput) => input)
  .handler(async ({ data }): Promise<ChangelogPostRouteData> => {
    const { getAdjacentChangelogEntries, getChangelogEntry } =
      await import('@site/lib/changelog.server');
    const entry = getChangelogEntry(data.locale, data.slug);
    if (!entry) throw notFound();

    const { newer, older } = getAdjacentChangelogEntries(data.locale, data.slug);

    return { entry, newer, older };
  });
