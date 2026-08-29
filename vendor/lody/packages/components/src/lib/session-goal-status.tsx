import type { ComponentType, SVGProps } from 'react';
import { AlertTriangle, CheckCircle2, CircleSlash, Pause } from 'lucide-react';
import { CarbonInProgress } from '@/components/icons/carbon-in-progress';
import type { SessionGoalStatus } from '@lody/shared';

export type GoalStatusIcon = ComponentType<SVGProps<SVGSVGElement> & { className?: string }>;

export interface GoalStatusPresentation {
  /** i18n key for the human-readable status label. */
  labelKey: string;
  fallbackLabel: string;
  Icon: GoalStatusIcon;
  /** Foreground colour for icon + label (`text-…`). */
  textClassName: string;
  /** Tinted surface used by the sticky banner; chat-inline marker can ignore. */
  surfaceClassName: string;
  /** Bottom-border tint matching the surface. */
  borderClassName: string;
  /** True when the icon should pulse to signal in-flight work. */
  pulse?: boolean;
}

// Single source of truth so the inline timeline marker (`view.tsx`) and the
// sticky banner (`session-goal-banner.tsx`) cannot drift on icon or colour.
export const GOAL_STATUS_PRESENTATION: Record<SessionGoalStatus, GoalStatusPresentation> = {
  active: {
    labelKey: 'sessions.goal.status.active',
    fallbackLabel: 'Pursuing goal',
    Icon: CarbonInProgress as GoalStatusIcon,
    textClassName: 'text-status-info',
    surfaceClassName: 'bg-status-info/10',
    borderClassName: 'border-status-info/30',
    pulse: true,
  },
  paused: {
    labelKey: 'sessions.goal.status.paused',
    fallbackLabel: 'Goal paused',
    Icon: Pause,
    textClassName: 'text-status-warning',
    surfaceClassName: 'bg-status-warning/10',
    borderClassName: 'border-status-warning/30',
  },
  budgetLimited: {
    labelKey: 'sessions.goal.status.budgetLimited',
    fallbackLabel: 'Goal unmet',
    Icon: AlertTriangle,
    textClassName: 'text-status-warning',
    surfaceClassName: 'bg-status-warning/10',
    borderClassName: 'border-status-warning/30',
  },
  blocked: {
    labelKey: 'sessions.goal.status.blocked',
    fallbackLabel: 'Goal blocked',
    Icon: AlertTriangle,
    textClassName: 'text-status-warning',
    surfaceClassName: 'bg-status-warning/10',
    borderClassName: 'border-status-warning/30',
  },
  usageLimited: {
    labelKey: 'sessions.goal.status.usageLimited',
    fallbackLabel: 'Usage limit reached',
    Icon: AlertTriangle,
    textClassName: 'text-status-warning',
    surfaceClassName: 'bg-status-warning/10',
    borderClassName: 'border-status-warning/30',
  },
  complete: {
    labelKey: 'sessions.goal.status.complete',
    fallbackLabel: 'Goal achieved',
    Icon: CheckCircle2,
    textClassName: 'text-status-success',
    surfaceClassName: 'bg-status-success/10',
    borderClassName: 'border-status-success/30',
  },
  cleared: {
    labelKey: 'sessions.goal.status.cleared',
    fallbackLabel: 'Goal cleared',
    Icon: CircleSlash,
    textClassName: 'text-muted-foreground',
    surfaceClassName: 'bg-muted/40',
    borderClassName: 'border-border/60',
  },
};

export const getGoalStatusPresentation = (
  status: SessionGoalStatus | string | undefined
): GoalStatusPresentation =>
  GOAL_STATUS_PRESENTATION[status as SessionGoalStatus] ?? GOAL_STATUS_PRESENTATION.active;
