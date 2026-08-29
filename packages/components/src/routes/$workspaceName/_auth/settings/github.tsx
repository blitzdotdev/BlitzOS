import { createFileRoute } from '@tanstack/react-router';
import { IntegrationsSettingsComponent } from '@/components/settings/integrations-setting';

export const Route = createFileRoute('/$workspaceName/_auth/settings/github')({
  component: IntegrationsSettingsComponent,
});
