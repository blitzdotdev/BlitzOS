import { Fragment, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, CircleOff, Download, Loader2, Plus } from 'lucide-react';
import type { BuiltinAgentType } from '@lody/shared';
import { Button } from '@/ui/button';
import { Switch } from '@/ui/switch';
import { cn } from '@/lib/utils';
import { AgentIcon } from '@/components/icons/agent-icon';
import { playHover } from '../ceremony/ui-sounds';

// The provider step, rebuilt around detection.
//
// It used to be a configuration surface: a list of what you had already set up,
// a showcase grid of what you could add, and a dialog behind every one of them.
// That asks a first-run user to answer a question they have no way to answer —
// which coding assistant, out of a dozen, and with what settings — before they
// have any reason to care about the difference.
//
// So the screen asks the machine instead. We probe for the assistants that are
// actually installed and present the answer: these are here, they are on, press
// continue. Configuring something is the escape hatch, not the path. The best
// way to flatten an unfamiliar concept is not to explain it in simpler words —
// it is to not make the user hold it at all.

export type DetectedAgentStatus =
  /** The probe is still running. */
  | 'checking'
  /** Found on this machine and ready to use. */
  | 'installed'
  /** Not here yet, but we can fetch it. */
  | 'missing'
  /** Cannot run here at all — wrong platform, incompatible host. */
  | 'unavailable';

export type DetectedAgent = {
  agentType: BuiltinAgentType;
  name: string;
  status: DetectedAgentStatus;
  /** Version when installed, or the reason when unavailable. */
  detail?: string;
  /** True when this machine already has a config for it. */
  configured: boolean;
};

export type DetectedAgentsProps = {
  agents: DetectedAgent[];
  /** Which agents the user wants. Keyed by agentType. */
  enabled: Record<string, boolean>;
  onToggle: (agentType: BuiltinAgentType, next: boolean) => void;
  /** Opens the full configuration dialog for anything not covered here. */
  onAddOther: () => void;
  /** The parent can place the add action after setup/custom rows. */
  showAddOther?: boolean;
  /** Replaces an already-configured builtin with its actionable config row. */
  renderConfiguredAgent?: (agent: DetectedAgent) => ReactNode;
  /** True while the local machine record has not arrived yet. */
  waitingForMachine: boolean;
};

export function DetectedAgents({
  agents,
  enabled,
  onToggle,
  onAddOther,
  showAddOther = true,
  renderConfiguredAgent,
  waitingForMachine,
}: DetectedAgentsProps) {
  const { t } = useTranslation();

  if (waitingForMachine) {
    return (
      <div className="flex items-center gap-2.5 py-6 text-[13px] text-slate-500">
        <Loader2 className="size-4 animate-spin" />
        {t('onboarding.providers.lookingAtMachine', 'Looking at this machine…')}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="divide-y divide-slate-200/70">
        {agents.map((agent) => {
          const configuredRow = agent.configured ? renderConfiguredAgent?.(agent) : null;
          return configuredRow ? (
            <Fragment key={agent.agentType}>{configuredRow}</Fragment>
          ) : (
            <AgentRow
              key={agent.agentType}
              agent={agent}
              enabled={enabled[agent.agentType] ?? false}
              onToggle={onToggle}
            />
          );
        })}
      </div>

      {showAddOther ? <AddOtherAgentButton onClick={onAddOther} /> : null}
    </div>
  );
}

export function AddOtherAgentButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onMouseEnter={() => playHover()}
      onClick={onClick}
      className={cn(
        'mt-4 inline-flex items-center gap-2 self-start rounded-lg px-2 py-1.5',
        'text-[13px] text-stone-500 transition hover:bg-stone-100 hover:text-stone-800'
      )}
    >
      <Plus className="size-3.5" />
      {t('onboarding.providers.addOther', 'I want to add another')}
    </button>
  );
}

function AgentRow({
  agent,
  enabled,
  onToggle,
}: {
  agent: DetectedAgent;
  enabled: boolean;
  onToggle: (agentType: BuiltinAgentType, next: boolean) => void;
}) {
  const { t } = useTranslation();
  // Unavailable means it cannot run here at all, so the switch would be a lie.
  // Already-configured rows stay on and locked: turning one off here would
  // imply we are about to delete it, and we are not.
  const locked = agent.status === 'unavailable' || agent.configured;
  const statusLabel =
    agent.status === 'checking'
      ? t('onboarding.providers.checking', 'Checking…')
      : agent.status === 'installed'
        ? t('onboarding.providers.foundHere', 'Found on this machine')
        : agent.status === 'missing'
          ? t('onboarding.providers.willFetch', 'Will be downloaded')
          : agent.detail || t('onboarding.providers.unavailable', 'Not available on this machine');

  return (
    <div className={cn('flex items-center gap-2.5 py-3.5', locked && 'opacity-60')}>
      <AgentIcon cliType="builtin" agentType={agent.agentType} className="size-5 shrink-0" />
      <div className="min-w-0 flex-1 truncate text-[14px] font-medium text-slate-950">
        {agent.name}
      </div>
      <span
        title={agent.detail ? `${statusLabel} · ${agent.detail}` : statusLabel}
        aria-label={`${agent.name}: ${statusLabel}`}
        className={cn(
          'inline-flex size-8 shrink-0 items-center justify-center rounded-full border',
          agent.status === 'installed' &&
            'border-emerald-500/30 bg-emerald-500/10 text-emerald-600',
          agent.status === 'missing' && 'border-sky-500/25 bg-sky-500/10 text-sky-600',
          agent.status === 'unavailable' && 'border-stone-200 bg-stone-100/60 text-stone-400',
          agent.status === 'checking' && 'border-stone-200 bg-white/50 text-stone-400'
        )}
      >
        {agent.status === 'checking' ? (
          <Loader2 className="size-4 animate-spin" />
        ) : agent.status === 'installed' ? (
          <CheckCircle2 className="size-4" />
        ) : agent.status === 'missing' ? (
          <Download className="size-4" />
        ) : (
          <CircleOff className="size-4" />
        )}
      </span>
      {agent.status !== 'checking' ? (
        <Switch
          checked={enabled}
          disabled={locked}
          aria-label={agent.name}
          onCheckedChange={(next) => onToggle(agent.agentType, next)}
        />
      ) : null}
    </div>
  );
}

/** Copy for the primary button, which depends on what the user left switched on. */
export function useDetectedAgentsAction(agents: DetectedAgent[], enabled: Record<string, boolean>) {
  const { t } = useTranslation();
  const pending = agents.filter(
    (agent) => !agent.configured && agent.status !== 'unavailable' && enabled[agent.agentType]
  );
  const needsFetch = pending.some((agent) => agent.status === 'missing');
  const label = needsFetch
    ? t('onboarding.providers.setUpAndFetch', 'Set these up')
    : pending.length > 0
      ? t('onboarding.providers.useThese', 'Use these')
      : t('common.next', 'Next');
  return { pending, label };
}

/** Nothing to do here yet, but the user should not be stuck. */
export function DetectedAgentsSkip({ onSkip }: { onSkip: () => void }) {
  const { t } = useTranslation();
  return (
    <Button variant="ghost" size="lg" onMouseEnter={() => playHover()} onClick={onSkip}>
      {t('onboarding.providers.skip', 'Skip for now')}
    </Button>
  );
}
