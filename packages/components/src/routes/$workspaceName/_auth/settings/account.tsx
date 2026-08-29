import { createFileRoute } from '@tanstack/react-router';
import { AccountSettingsComponent } from '@/components/settings/account-setting';

export const Route = createFileRoute('/$workspaceName/_auth/settings/account')({
  component: AccountSettingsComponent,
});
