import type { BlogEntry, BlogLocale } from '@site/lib/blog';
import { createServerFn } from '@tanstack/react-start';
import { notFound } from '@tanstack/react-router';
import { staticFunctionMiddleware } from '@tanstack/start-static-server-functions';

type BlogLocaleInput = {
  locale: BlogLocale;
};

type BlogPostInput = BlogLocaleInput & {
  splat?: string;
};

export type BlogPostRouteData = {
  entry: BlogEntry;
  /** Published before `entry` (entries are newest-first). */
  previous?: BlogEntry;
  /** Published after `entry`. */
  next?: BlogEntry;
};

function slugFromSplat(splat: string | undefined): string[] | undefined {
  const segments = splat?.split('/').filter((segment) => segment.length > 0) ?? [];
  return segments.length > 0 ? segments : undefined;
}

export const loadBlogIndexRoute = createServerFn({ method: 'GET' })
  .middleware([staticFunctionMiddleware])
  .validator((input: BlogLocaleInput) => input)
  .handler(async ({ data }): Promise<BlogEntry[]> => {
    const { getBlogEntries } = await import('@site/lib/blog.server');

    return getBlogEntries(data.locale);
  });

export const loadBlogPostRoute = createServerFn({ method: 'GET' })
  .middleware([staticFunctionMiddleware])
  .validator((input: BlogPostInput) => input)
  .handler(async ({ data }): Promise<BlogPostRouteData> => {
    const slug = slugFromSplat(data.splat);
    if (!slug) throw notFound();

    const { getBlogEntries } = await import('@site/lib/blog.server');
    const entries = getBlogEntries(data.locale);
    const index = entries.findIndex((candidate) => candidate.slug === slug.join('/'));
    if (index < 0) throw notFound();

    return {
      entry: entries[index] as BlogEntry,
      previous: entries[index + 1],
      next: entries[index - 1],
    };
  });
