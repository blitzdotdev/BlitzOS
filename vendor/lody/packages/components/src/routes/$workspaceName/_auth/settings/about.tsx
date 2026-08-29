import { createFileRoute } from '@tanstack/react-router';
import { AboutSettingsComponent } from '@/components/settings/about-setting';

export const Route = createFileRoute('/$workspaceName/_auth/settings/about')({
  component: AboutSettingsComponent,
});
