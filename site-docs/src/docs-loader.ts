import type { DocsRouteData, SiteLocale } from '@site/src/site-pages/shared';
import { createServerFn } from '@tanstack/react-start';
import { staticFunctionMiddleware } from '@tanstack/start-static-server-functions';

type LoadDocsRouteInput = {
  locale: SiteLocale;
  splat?: string;
};

export const loadDocsRoute = createServerFn({ method: 'GET', strict: { output: false } })
  .middleware([staticFunctionMiddleware])
  .validator((input: LoadDocsRouteInput) => input)
  .handler(async ({ data }): Promise<DocsRouteData> => {
    const { loadDocsRouteData } = await import('@site/lib/docs.server');

    return await loadDocsRouteData(data.locale, data.splat);
  });
