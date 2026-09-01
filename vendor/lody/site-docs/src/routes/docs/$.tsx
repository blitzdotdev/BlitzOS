import { createFileRoute } from '@tanstack/react-router';
import { loadDocsRoute } from '@site/src/docs-loader';
import { DocsRoutePage, docsHead, preloadDocsContent } from '@site/src/site-pages/docs';
export const Route = createFileRoute('/docs/$')({
  loader: async ({ params }) => {
    const data = await loadDocsRoute({ data: { locale: 'en', splat: params._splat } });
    await preloadDocsContent('en', data.docPath);

    return data;
  },
  head: ({ loaderData }) => docsHead('en', loaderData!),
  component: Docs,
});

function Docs() {
  const data = Route.useLoaderData();

  return <DocsRoutePage locale="en" data={data} />;
}
