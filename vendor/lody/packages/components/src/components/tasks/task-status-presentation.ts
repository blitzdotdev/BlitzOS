import {
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleSlash,
  Eye,
  type LucideIcon,
} from 'lucide-react';

import type { TaskStatus } from '@lody/shared';

export type TaskStatusPresentation = {
  status: TaskStatus;
  Icon: LucideIcon;
  /** i18n key and English fallback for the column/group label. */
  labelKey: string;
  labelFallback: string;
  /** Semantic colour, used only where status is the point (column heads, chips). */
  className: string;
};

/**
 * Column order is fixed and matches the lifecycle, so the board never reshuffles
 * under the user.
 */
export const TASK_STATUS_PRESENTATION: readonly TaskStatusPresentation[] = [
  {
    status: 'backlog',
    // Dashed = not yet triaged, distinct from `todo`'s solid outline (Linear's
    // convention). If backlog and todo share an icon the two columns become
    // visually indistinguishable at a glance, which is the whole reason a
    // status split exists.
    Icon: CircleDashed,
    labelKey: 'tasks.status.backlog',
    labelFallback: 'Backlog',
    className: 'text-muted-foreground',
  },
  {
    status: 'todo',
    Icon: Circle,
    labelKey: 'tasks.status.todo',
    labelFallback: 'Todo',
    className: 'text-muted-foreground',
  },
  {
    status: 'in_progress',
    Icon: CircleDot,
    labelKey: 'tasks.status.inProgress',
    labelFallback: 'In progress',
    className: 'text-status-info',
  },
  {
    status: 'needs_review',
    Icon: Eye,
    labelKey: 'tasks.status.needsReview',
    labelFallback: 'Needs review',
    className: 'text-status-warning',
  },
  {
    status: 'done',
    Icon: CircleCheck,
    labelKey: 'tasks.status.done',
    labelFallback: 'Done',
    className: 'text-status-success',
  },
  {
    status: 'canceled',
    Icon: CircleSlash,
    labelKey: 'tasks.status.canceled',
    labelFallback: "Won't do",
    className: 'text-muted-foreground',
  },
];

const byStatus = new Map(TASK_STATUS_PRESENTATION.map((entry) => [entry.status, entry]));

export const getTaskStatusPresentation = (status: TaskStatus): TaskStatusPresentation =>
  byStatus.get(status) ?? {
    status,
    Icon: CircleDashed,
    labelKey: 'tasks.status.unknown',
    labelFallback: 'Unknown',
    className: 'text-muted-foreground',
  };
