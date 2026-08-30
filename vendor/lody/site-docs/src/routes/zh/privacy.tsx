import { preloadLegalPageContent } from '@site/components/legal-page';
import { loadLegalPageRoute } from '@site/src/pages-loader';
import { LegalRoutePage, legalPageHead } from '@site/src/site-pages/legal';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/zh/privacy')({
  loader: async () => {
    const data = await loadLegalPageRoute({ data: { locale: 'zh', slug: 'privacy' } });
    await preloadLegalPageContent('zh', data.docPath);
    return data;
  },
  head: ({ loaderData }) =>
    loaderData ? legalPageHead('zh', loaderData) : { meta: [{ title: '隐私政策' }] },
  component: PrivacyPage,
});

function PrivacyPage() {
  const data = Route.useLoaderData();
  return <LegalRoutePage entry={data} locale="zh" />;
}
