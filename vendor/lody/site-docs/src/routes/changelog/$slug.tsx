import { preloadChangelogContent } from '@site/components/changelog';
import { loadChangelogPostRoute } from '@site/src/changelog-loader';
import { ChangelogPostRoutePage, changelogIndexHead, changelogPostHead } from '@site/src/site-pages/changelog';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/changelog/$slug')({
  loader: async ({ params }) => {
    const data = await loadChangelogPostRoute({ data: { locale: 'en', slug: params.slug } });
    await preloadChangelogContent('en', data.entry.docPath);

    return data;
  },
  head: ({ loaderData }) =>
    loaderData ? changelogPostHead('en', loaderData) : changelogIndexHead('en'),
  component: ChangelogPost,
});

function ChangelogPost() {
  const data = Route.useLoaderData();

  return <ChangelogPostRoutePage data={data} locale="en" />;
}
