import { createFileRoute } from '@tanstack/react-router';
import { TasksBetaRouteGuard } from '@/components/tasks/tasks-beta-route-guard';
import { TasksWorkspace } from '@/components/tasks/tasks-workspace';

// Static import on purpose. Tasks is a primary sidebar destination, so splitting
// it out saves nothing in practice, and a lazy chunk adds a failure mode the repo
// already documents: after an app update a stale chunk fails to evaluate and the
// page simply will not load.
export const Route = createFileRoute('/$workspaceName/_auth/tasks/')({
  component: TasksRoute,
});

function TasksRoute() {
  return (
    <TasksBetaRouteGuard>
      <TasksWorkspace />
    </TasksBetaRouteGuard>
  );
}
