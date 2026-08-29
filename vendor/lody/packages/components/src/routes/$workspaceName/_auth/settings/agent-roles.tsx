import { createFileRoute } from '@tanstack/react-router';
import { AgentRolesSetting } from '@/components/settings/agent-roles-setting';

export const Route = createFileRoute('/$workspaceName/_auth/settings/agent-roles')({
  component: AgentRolesSetting,
});
