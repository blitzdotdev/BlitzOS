import { LandingRoutePage, landingHead } from '@site/src/site-pages/landing';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/zh/home')({
  head: () => landingHead('zh', { noindex: true }),
  component: () => <LandingRoutePage locale="zh" />,
});
