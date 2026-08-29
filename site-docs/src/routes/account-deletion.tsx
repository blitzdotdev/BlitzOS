import { preloadLegalPageContent } from '@site/components/legal-page';
import { loadLegalPageRoute } from '@site/src/pages-loader';
import { LegalRoutePage, legalPageHead } from '@site/src/site-pages/legal';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/account-deletion')({
  loader: async () => {
    const data = await loadLegalPageRoute({ data: { locale: 'en', slug: 'account-deletion' } });
    await preloadLegalPageContent('en', data.docPath);
    return data;
  },
  head: ({ loaderData }) =>
    loaderData
      ? legalPageHead('en', loaderData)
      : { meta: [{ title: 'Account and Data Deletion' }] },
  component: AccountDeletionPage,
});

function AccountDeletionPage() {
  const data = Route.useLoaderData();
  return <LegalRoutePage entry={data} locale="en" />;
}
