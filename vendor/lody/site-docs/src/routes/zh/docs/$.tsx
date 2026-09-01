import { createFileRoute } from '@tanstack/react-router';
import { loadDocsRoute } from '@site/src/docs-loader';
import { DocsRoutePage, docsHead, preloadDocsContent } from '@site/src/site-pages/docs';
export const Route = createFileRoute('/zh/docs/$')({
  loader: async ({ params }) => {
    const data = await loadDocsRoute({ data: { locale: 'zh', splat: params._splat } });
    await preloadDocsContent('zh', data.docPath);

    return data;
  },
  head: ({ loaderData }) => docsHead('zh', loaderData!),
  component: Docs,
});

function Docs() {
  const data = Route.useLoaderData();

  return <DocsRoutePage locale="zh" data={data} />;
}
