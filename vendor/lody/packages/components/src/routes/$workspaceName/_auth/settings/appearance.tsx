import { createFileRoute } from '@tanstack/react-router';
import { AppearanceSettingsComponent } from '@/components/settings/appearance-setting';

export const Route = createFileRoute('/$workspaceName/_auth/settings/appearance')({
  component: AppearanceSettingsComponent,
});
