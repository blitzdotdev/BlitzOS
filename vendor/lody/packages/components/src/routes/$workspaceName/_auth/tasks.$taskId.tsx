import { createFileRoute } from '@tanstack/react-router';
import { TasksBetaRouteGuard } from '@/components/tasks/tasks-beta-route-guard';
import { TasksWorkspace } from '@/components/tasks/tasks-workspace';

// Static import on purpose. Tasks is a primary sidebar destination, so splitting
// it out saves nothing in practice, and a lazy chunk adds a failure mode the repo
// already documents: after an app update a stale chunk fails to evaluate and the
// page simply will not load.
//
// Same shell as the index route: desktop keeps "All Tasks" + open detail tabs
// across both URLs; the path only selects which tab is active.
export const Route = createFileRoute('/$workspaceName/_auth/tasks/$taskId')({
  component: TaskDetailRoute,
});

function TaskDetailRoute() {
  return (
    <TasksBetaRouteGuard>
      <TasksWorkspace />
    </TasksBetaRouteGuard>
  );
}
