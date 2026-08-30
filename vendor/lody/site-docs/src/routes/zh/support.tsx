import { preloadLegalPageContent } from '@site/components/legal-page';
import { loadLegalPageRoute } from '@site/src/pages-loader';
import { LegalRoutePage, legalPageHead } from '@site/src/site-pages/legal';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/zh/support')({
  loader: async () => {
    const data = await loadLegalPageRoute({ data: { locale: 'zh', slug: 'support' } });
    await preloadLegalPageContent('zh', data.docPath);
    return data;
  },
  head: ({ loaderData }) =>
    loaderData ? legalPageHead('zh', loaderData) : { meta: [{ title: '支持' }] },
  component: SupportPage,
});

function SupportPage() {
  const data = Route.useLoaderData();
  return <LegalRoutePage entry={data} locale="zh" />;
}
