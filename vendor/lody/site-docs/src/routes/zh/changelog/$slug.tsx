import { preloadChangelogContent } from '@site/components/changelog';
import { loadChangelogPostRoute } from '@site/src/changelog-loader';
import { ChangelogPostRoutePage, changelogIndexHead, changelogPostHead } from '@site/src/site-pages/changelog';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/zh/changelog/$slug')({
  loader: async ({ params }) => {
    const data = await loadChangelogPostRoute({ data: { locale: 'zh', slug: params.slug } });
    await preloadChangelogContent('zh', data.entry.docPath);

    return data;
  },
  head: ({ loaderData }) =>
    loaderData ? changelogPostHead('zh', loaderData) : changelogIndexHead('zh'),
  component: ChangelogPost,
});

function ChangelogPost() {
  const data = Route.useLoaderData();

  return <ChangelogPostRoutePage data={data} locale="zh" />;
}
