import { createFileRoute } from '@tanstack/react-router';
import { HomeRoute } from './index';

export const Route = createFileRoute('/app')({
  component: HomeRoute,
});
