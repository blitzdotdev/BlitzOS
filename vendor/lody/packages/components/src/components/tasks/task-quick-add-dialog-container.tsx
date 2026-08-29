import { useCallback, useMemo, useState } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { useRouter } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { cloudOperations } from '@/lib/cloud-api-operations';
import {
  archivedSessionListAtom,
  currentWorkspaceIdAtom,
  currentWorkspaceSlugAtom,
  sessionListAtom,
} from '@/atoms';
import {
  taskQuickAddCreateMoreAtom,
  taskQuickAddOpenAtom,
  taskQuickAddStatusAtom,
} from '@/atoms/tasks';
import { useCloudQuery } from '@lody/platform/react';
import { useVisibleLocalProjects } from '@/hooks/use-visible-local-projects';
import { useOpenSettings } from '@/hooks/use-open-settings';
import { getAllAgentConfigAtom } from '@/atoms/agents';
import { useTaskActions } from '@/hooks/use-task-actions';
import type { UnifiedLocalProjectOption } from '@/components/chat/unified-project-selector';
import { getChatLandingProjectRecency } from '@/components/chat/chat-landing-derived';
import { TaskQuickAddDialog, type TaskQuickAddSubmit } from './task-quick-add-dialog';

/**
 * Mounted once in the app layout: quick add is reachable from any page, so the
 * dialog cannot live inside a route component.
 */
export function TaskQuickAddDialogContainer() {
  const { t } = useTranslation();
  const router = useRouter();
  const workspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const [open, setOpen] = useAtom(taskQuickAddOpenAtom);
  const [createMore, setCreateMore] = useAtom(taskQuickAddCreateMoreAtom);
  const [initialStatus, setInitialStatus] = useAtom(taskQuickAddStatusAtom);
  const { createTask } = useTaskActions();
  // Same agents the task page offers. Only names are needed here: the chip
  // writes an agent id, and reachability is an agent property the capture step
  // deliberately does not evaluate.
  const agentOptions = (
    useAtomValue(getAllAgentConfigAtom) as { id: string; name?: string; cliType: string }[]
  ).map((config) => ({ agentConfigId: config.id, name: config.name || config.cliType }));
  const [submitting, setSubmitting] = useState(false);
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const activeSessions = useAtomValue(sessionListAtom);
  const archivedSessions = useAtomValue(archivedSessionListAtom);
  const localProjects = useVisibleLocalProjects({ includeMachineFlock: true });
  const githubRepositories = useCloudQuery(
    cloudOperations.github.getWorkspaceRepositories,
    workspaceId ? { workspaceId } : 'skip'
  ) as { repoFullName?: string; fullName?: string }[] | null | undefined;
  const { openSettings } = useOpenSettings();
  const projectRecency = useMemo(
    () => getChatLandingProjectRecency([...activeSessions, ...archivedSessions]),
    [activeSessions, archivedSessions]
  );

  // Capture does not pick an agent, so every machine's projects stay listed —
  // reachability greying is a property of the chosen agent on the task page.
  const unifiedLocalProjects = useMemo<UnifiedLocalProjectOption[]>(() => {
    return [...localProjects.projects.values()].map((entry) => ({
      key: entry.key,
      machineId: entry.machineId,
      localProjectId: entry.project.id,
      name: entry.project.name,
      rootPath: `${entry.machine.name} · ${entry.project.rootPath}`,
      lastUsedAt:
        projectRecency.byProject.get(entry.key) ??
        entry.project.lastOpenedAtMs ??
        entry.project.createdAtMs,
    }));
  }, [localProjects.projects, projectRecency.byProject]);

  const repositories = useMemo(
    () =>
      (githubRepositories ?? []).flatMap((repository) => {
        const fullName = repository.repoFullName ?? repository.fullName;
        return fullName ? [{ fullName }] : [];
      }),
    [githubRepositories]
  );

  const handleSubmit = useCallback(
    (input: TaskQuickAddSubmit) => {
      void (async () => {
        setSubmitting(true);
        try {
          const taskId = await createTask({
            title: input.title,
            body: input.body,
            status: input.status,
            ...(input.project ? { projects: [input.project] } : {}),
            ...(input.priority ? { priority: input.priority } : {}),
            ...(input.labels.length > 0 ? { labels: input.labels } : {}),
            // Two distinct writes on purpose: the picked runner is always
            // `lastRunConfig`, and `agent` is set ONLY when the user explicitly
            // asked for auto-run. Collapsing them is the old bug where merely
            // choosing an agent let the scheduler start the task.
            ...(input.runAgent ? { lastRunConfig: input.runAgent } : {}),
            ...(input.runAgent && input.delegated ? { agent: input.runAgent } : {}),
          });
          if (!taskId) {
            return;
          }
          if (input.createMore) {
            return;
          }
          setOpen(false);
          setInitialStatus(null);
          if (workspaceSlug) {
            // Landing on the new task is the expected result of creating one;
            // "Create more" is the opt-out for capturing several in a row.
            void router.navigate({
              to: '/$workspaceName/tasks/$taskId',
              params: { workspaceName: workspaceSlug, taskId },
            });
          }
        } catch (error: unknown) {
          toast.error(
            t('tasks.quickAdd.createFailed', 'Could not create the task: {{message}}', {
              message: error instanceof Error ? error.message : String(error),
            })
          );
        } finally {
          setSubmitting(false);
        }
      })();
    },
    [createTask, router, setInitialStatus, setOpen, t, workspaceSlug]
  );

  return (
    <TaskQuickAddDialog
      open={open}
      submitting={submitting}
      createMore={createMore}
      onCreateMoreChange={setCreateMore}
      initialStatus={initialStatus ?? 'backlog'}
      localProjects={unifiedLocalProjects}
      repositories={repositories}
      latestMessageAtByRepo={projectRecency.byRepo}
      onAddLocalProject={() => openSettings('projects')}
      onConnectGitRepo={() => openSettings('github')}
      agentOptions={agentOptions}
      onSubmit={handleSubmit}
      onClose={() => {
        setOpen(false);
        setInitialStatus(null);
      }}
    />
  );
}
