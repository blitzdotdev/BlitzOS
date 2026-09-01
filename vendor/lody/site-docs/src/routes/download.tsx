import { DownloadRoutePage, downloadHead } from '@site/src/site-pages/download';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/download')({
  head: () => downloadHead('en'),
  component: () => <DownloadRoutePage locale="en" />,
});
