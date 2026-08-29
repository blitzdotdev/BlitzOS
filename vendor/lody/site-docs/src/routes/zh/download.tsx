import { DownloadRoutePage, downloadHead } from '@site/src/site-pages/download';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/zh/download')({
  head: () => downloadHead('zh'),
  component: () => <DownloadRoutePage locale="zh" />,
});
