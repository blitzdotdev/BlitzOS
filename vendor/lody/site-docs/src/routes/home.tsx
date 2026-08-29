import { LandingRoutePage, landingHead } from '@site/src/site-pages/landing';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/home')({
  head: () => landingHead('en', { noindex: true }),
  component: () => <LandingRoutePage locale="en" />,
});
