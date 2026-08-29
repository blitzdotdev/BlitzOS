import { preloadLegalPageContent } from '@site/components/legal-page';
import { loadLegalPageRoute } from '@site/src/pages-loader';
import { LegalRoutePage, legalPageHead } from '@site/src/site-pages/legal';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/zh/account-deletion')({
  loader: async () => {
    const data = await loadLegalPageRoute({ data: { locale: 'zh', slug: 'account-deletion' } });
    await preloadLegalPageContent('zh', data.docPath);
    return data;
  },
  head: ({ loaderData }) =>
    loaderData ? legalPageHead('zh', loaderData) : { meta: [{ title: '账号与数据删除' }] },
  component: AccountDeletionPage,
});

function AccountDeletionPage() {
  const data = Route.useLoaderData();
  return <LegalRoutePage entry={data} locale="zh" />;
}
