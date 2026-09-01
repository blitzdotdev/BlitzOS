import { LandingRoutePage, landingHead } from '@site/src/site-pages/landing';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/zh/')({
  head: () => landingHead('zh'),
  component: () => <LandingRoutePage locale="zh" />,
});
