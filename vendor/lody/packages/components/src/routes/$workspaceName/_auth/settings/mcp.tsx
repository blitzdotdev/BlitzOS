import { createFileRoute } from '@tanstack/react-router';
import { McpSetting } from '@/components/settings/mcp-setting';

export const Route = createFileRoute('/$workspaceName/_auth/settings/mcp')({
  component: McpSetting,
});
