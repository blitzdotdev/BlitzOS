import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtomValue } from 'jotai';
import { v4 as uuidv4 } from 'uuid';
import { FolderGit2 } from 'lucide-react';
import {
  buildInitialHistoryEntry,
  getServerNow,
  type AgentConfigMeta,
  type LocalProjectId,
  type ProjectRef,
  type SessionId,
} from '@lody/shared';
import { userAtom } from '@/atoms';
import { getAllAgentConfigAtom } from '@/atoms/agents';
import type { DesktopOnboardingProjectSelection } from '@/atoms/onboarding';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '@/atoms/workspace-context';
import { useSessionActions } from '@/hooks/use-session-actions';
import { buildAgentPrompt } from '@/lib';
import { cn } from '@/lib/utils';
import { AgentIcon } from '@/components/icons/agent-icon';
import { Textarea } from '@/ui/textarea';
import { OnboardingBackButton, OnboardingNextButton, OnboardingShell } from '../onboarding-shell';

export function FirstTaskScreen({
  agentConfigId,
  project,
  onBack,
  onSessionStarted,
}: {
  agentConfigId: string;
  project: DesktopOnboardingProjectSelection;
  onBack: () => void;
  onSessionStarted: (input: { sessionId: string; workspaceSlug: string }) => void;
}) {
  const { t } = useTranslation();
  const user = useAtomValue(userAtom);
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const workspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const configs = useAtomValue(getAllAgentConfigAtom);
  const { startSession, requestSessionDispatch } = useSessionActions();
  const config: AgentConfigMeta | null = useMemo(
    () => configs.find((candidate) => candidate.id === agentConfigId) ?? null,
    [agentConfigId, configs]
  );
  const seedPrompts = useMemo(
    () => [
      t('onboarding.firstTask.seedExplore', 'Walk me through how this codebase is organized.'),
      t('onboarding.firstTask.seedTests', 'Find the test setup and explain how to run it.'),
      t('onboarding.firstTask.seedReadme', 'Summarize the main entry points in this project.'),
    ],
    [t]
  );
  const [prompt, setPrompt] = useState(seedPrompts[0] ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canRun =
    project.kind === 'local' &&
    config !== null &&
    config.machineId === project.machineId &&
    runtime !== null &&
    user !== null &&
    workspaceId !== null &&
    workspaceSlug !== null &&
    !submitting &&
    prompt.trim().length > 0;

  const handleSubmit = useCallback(() => {
    if (!canRun || project.kind !== 'local' || !config || !user || !workspaceSlug) return;
    const trimmedPrompt = prompt.trim();
    setSubmitting(true);
    setError(null);
    void (async () => {
      try {
        const projectRef: ProjectRef = {
          kind: 'local',
          localProjectId: project.localProjectId as LocalProjectId,
        };
        const entry = buildInitialHistoryEntry({
          userId: user.id,
          timestamp: new Date(getServerNow()).toISOString(),
          cliType: config.cliType,
          agentType: config.agentType,
          prompt: buildAgentPrompt(trimmedPrompt, config.prompt ?? ''),
          inputBlocks: undefined,
        });
        if (!entry) throw new Error('Could not build the first turn');
        const result = await startSession(
          {
            sessionId: uuidv4() as SessionId,
            userId: user.id,
            cliType: config.cliType,
            agentType: config.agentType,
            customAcp: config.customAcp,
            runtimeOverrides: config.runtimeOverrides,
            machineId: project.machineId,
            agentConfigId: config.id,
            env: config.env,
            project: projectRef,
            title: trimmedPrompt.slice(0, 50),
            titleSource: 'draft',
          },
          entry
        );
        await requestSessionDispatch(result.sessionId, result.historyEntry.id, {
          inputConfig: result.historyEntry.inputConfig,
          machineId: project.machineId,
        });
        onSessionStarted({ sessionId: result.sessionId, workspaceSlug });
      } catch (submitError) {
        console.error('Failed to start the first onboarding session', submitError);
        setError(
          t(
            'onboarding.firstTask.startFailed',
            'The session could not start. Check the agent and try again.'
          )
        );
        setSubmitting(false);
      }
    })();
  }, [
    canRun,
    config,
    onSessionStarted,
    project,
    prompt,
    requestSessionDispatch,
    startSession,
    t,
    user,
    workspaceSlug,
  ]);

  return (
    <OnboardingShell
      stepKey="firstTask"
      title={t('onboarding.firstTask.title', 'Start your first session')}
      description={t(
        'onboarding.firstTask.description',
        'This creates a real session against the project and agent you selected.'
      )}
      previewIdentity={{
        projectName: project.name,
        ...(config
          ? {
              agentName: config.name,
              agentType: config.agentType,
              agentCliType: config.cliType,
            }
          : {}),
      }}
      previewState={{
        agentStatus: config ? 'ready' : 'preparing',
        projectStatus: 'ready',
        promptValue: prompt,
        conversationStatus: submitting ? 'starting' : prompt.trim() ? 'draft' : 'empty',
      }}
      secondaryAction={<OnboardingBackButton onClick={onBack} disabled={submitting} />}
      primaryAction={
        <OnboardingNextButton
          finish
          onClick={handleSubmit}
          disabled={!canRun}
          loading={submitting}
          label={t('onboarding.firstTask.run', 'Run first task')}
        />
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/20 px-4 py-3">
          <FolderGit2 className="size-5 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{project.name}</div>
            <div className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
              {config ? (
                <>
                  <AgentIcon
                    cliType={config.cliType}
                    agentType={config.agentType}
                    brandId={config.brandId}
                    env={config.env}
                    className="size-3.5"
                  />
                  {config.name}
                </>
              ) : (
                t('onboarding.firstTask.preparingAgent', 'Preparing the selected agent…')
              )}
            </div>
          </div>
        </div>
        <Textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={4}
          disabled={submitting}
          placeholder={t('onboarding.firstTask.promptPlaceholder', 'What should Lody do first?')}
        />
        <div className="flex flex-wrap gap-2">
          {seedPrompts.map((seed) => (
            <button
              key={seed}
              type="button"
              onClick={() => setPrompt(seed)}
              disabled={submitting}
              className={cn(
                'rounded-full border border-border px-3 py-1 text-xs text-muted-foreground',
                'hover:bg-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring'
              )}
            >
              {seed}
            </button>
          ))}
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
    </OnboardingShell>
  );
}
