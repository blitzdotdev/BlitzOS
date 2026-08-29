import { LandingRoutePage, landingHead } from '@site/src/site-pages/landing';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/')({
  head: () => landingHead('en'),
  component: () => <LandingRoutePage locale="en" />,
});
