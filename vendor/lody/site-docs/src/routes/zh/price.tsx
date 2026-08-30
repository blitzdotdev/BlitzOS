import { createFileRoute } from '@tanstack/react-router';
import { PricingRoutePage, pricingHead } from '@site/src/site-pages/pricing';
export const Route = createFileRoute('/zh/price')({
  head: () => pricingHead('zh'),
  component: () => <PricingRoutePage locale="zh" />,
});
