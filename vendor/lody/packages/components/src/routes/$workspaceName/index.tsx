import { createFileRoute, Navigate } from '@tanstack/react-router';

export const Route = createFileRoute('/$workspaceName/')({
  component: WorkspaceIndexRoute,
});

function WorkspaceIndexRoute() {
  const { workspaceName } = Route.useParams();
  return <Navigate to="/$workspaceName/chat" params={{ workspaceName }} replace />;
}
