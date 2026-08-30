import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { AlarmClock, CalendarClock, ChevronDown, Repeat } from 'lucide-react';
import { getServerNow, resolveFireMs, type PendingScheduledTask } from '@lody/shared';
import { cn } from '@/lib/utils';

export interface ScheduledTasksPanelProps {
  tasks: readonly PendingScheduledTask[] | undefined;
  className?: string;
}

/** A one-shot task (wakeup or non-recurring cron) past its fire time by this much is
 *  treated as already fired and hidden. Kept short so the row clears right at fire time
 *  (after a brief "firing now…"), not minutes later. */
const FIRED_HIDE_GRACE_MS = 2_000;

/** Within this window before a fire, tick every second so the countdown/clear is snappy;
 *  the coarse interval elsewhere keeps this cheap. Wider than 60s so a coarse tick can't
 *  skip the whole final minute. */
const FINE_GRAINED_WINDOW_MS = 90_000;
const COARSE_TICK_MS = 30_000;
const FINE_TICK_MS = 1_000;

export type ResolvedScheduledTask = {
  task: PendingScheduledTask;
  /** Concrete next fire time (epoch ms) when we can resolve one. */
  fireMs: number | undefined;
};

/**
 * Ticks the clock so time-derived UI (countdown, absolute time, fired-task hiding) stays
 * live. Self-reschedules and reads `fineGrainedRef` each tick: a 1s cadence in the final
 * ~minute before a fire and while a just-fired task clears, coarse otherwise.
 */
function useAdaptiveClock(active: boolean, fineGrainedRef: RefObject<boolean>): number {
  const [nowMs, setNowMs] = useState(() => getServerNow());
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = () => {
      const delay = fineGrainedRef.current ? FINE_TICK_MS : COARSE_TICK_MS;
      timer = setTimeout(() => {
        if (cancelled) return;
        setNowMs(getServerNow());
        loop();
      }, delay);
    };
    if (active) loop();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, fineGrainedRef]);
  return nowMs;
}

function useFireTimeFormatter(): (fireMs: number, nowMs: number) => string {
  const { i18n } = useTranslation();
  const locale = i18n.language.replace('_', '-');
  return (fireMs, nowMs) => {
    const fire = new Date(fireMs);
    const now = new Date(nowMs);
    const sameDay =
      fire.getFullYear() === now.getFullYear() &&
      fire.getMonth() === now.getMonth() &&
      fire.getDate() === now.getDate();
    const options: Intl.DateTimeFormatOptions = sameDay
      ? { hour: '2-digit', minute: '2-digit', hour12: false }
      : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false };
    try {
      return new Intl.DateTimeFormat(locale, options).format(fire);
    } catch {
      return new Intl.DateTimeFormat(undefined, options).format(fire);
    }
  };
}

function useRelativeFireLabel(): (fireMs: number, nowMs: number) => string {
  const { t } = useTranslation();
  return (fireMs, nowMs) => {
    const diffMs = fireMs - nowMs;
    if (diffMs <= 5_000) return t('sessions.scheduledTasks.firing');
    const seconds = Math.round(diffMs / 1000);
    if (seconds < 60) return t('sessions.scheduledTasks.firesInSeconds', { count: seconds });
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return t('sessions.scheduledTasks.firesInMinutes', { count: minutes });
    const hours = Math.round(minutes / 60);
    if (hours < 24) return t('sessions.scheduledTasks.firesInHours', { count: hours });
    const days = Math.round(hours / 24);
    return t('sessions.scheduledTasks.firesInDays', { count: days });
  };
}

/**
 * Live-resolved view of a session's pending scheduled tasks: concrete next
 * fire times + an adaptive clock (1s cadence in the final ~minute before a
 * fire, coarse otherwise). Shared by the composer panel and the info-bar
 * schedule chip so their countdowns can never drift apart.
 */
export function useResolvedScheduledTasks(tasks: readonly PendingScheduledTask[] | undefined): {
  rows: ResolvedScheduledTask[];
  nowMs: number;
} {
  const hasTimedTask = useMemo(
    () =>
      (tasks ?? []).some((task) =>
        task.kind === 'wakeup'
          ? typeof task.scheduledForMs === 'number'
          : typeof task.humanSchedule === 'string'
      ),
    [tasks]
  );
  // The clock effect reads this each tick to choose its cadence (updated below).
  const fineGrainedRef = useRef(false);
  const nowMs = useAdaptiveClock(hasTimedTask, fineGrainedRef);

  const rows = useMemo<ResolvedScheduledTask[]>(() => {
    return (
      (tasks ?? [])
        .map((task) => ({ task, fireMs: resolveFireMs(task, nowMs) }))
        .filter(({ task, fireMs }) => {
          // Hide one-shot tasks (wakeups + non-recurring cron) once they have fired.
          // Recurring cron always resolves to a future occurrence, so it stays.
          const recurring = task.kind === 'cron' && task.recurring === true;
          if (!recurring && typeof fireMs === 'number') {
            return fireMs > nowMs - FIRED_HIDE_GRACE_MS;
          }
          return true;
        })
        // Soonest fire first; tasks without a resolvable time sink to the bottom.
        .sort((a, b) => (a.fireMs ?? Infinity) - (b.fireMs ?? Infinity))
    );
  }, [tasks, nowMs]);

  // Tick every second while any visible task is within the final window before firing
  // (or just fired and clearing); coarse otherwise.
  fineGrainedRef.current = rows.some(
    ({ fireMs }) => fireMs !== undefined && fireMs - nowMs <= FINE_GRAINED_WINDOW_MS
  );

  return { rows, nowMs };
}

/**
 * Compact panel shown above the composer when a session has future-firing scheduled
 * tasks (cron jobs / wakeups). Lets the user know the session is not fully finished and
 * will trigger again. Tasks are derived from session history (see
 * `collectPendingScheduledTasksFromHistory`); nothing extra is persisted.
 */
export function ScheduledTasksPanel({ tasks, className }: ScheduledTasksPanelProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const { rows, nowMs } = useResolvedScheduledTasks(tasks);

  if (rows.length === 0) return null;

  return (
    <div
      className={cn(
        'mb-2 overflow-hidden rounded-md border border-border/60 bg-muted/50 text-xs',
        className
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={t('sessions.scheduledTasks.toggle')}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-muted-foreground transition-colors hover:text-foreground"
      >
        <AlarmClock className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
        <span className="font-medium text-foreground">{t('sessions.scheduledTasks.heading')}</span>
        <span className="truncate">
          · {t('sessions.scheduledTasks.summary', { count: rows.length })}
        </span>
        <ChevronDown
          className={cn(
            'ml-auto h-3.5 w-3.5 shrink-0 transition-transform',
            expanded && 'rotate-180'
          )}
          aria-hidden="true"
        />
      </button>
      {expanded ? (
        <ScheduledTaskList
          rows={rows}
          nowMs={nowMs}
          className="border-t border-border/50 px-2 py-1.5"
        />
      ) : null}
    </div>
  );
}

/**
 * The resolved task rows (fire time · kind · countdown · summary). Shared by
 * the panel's expanded state and the info-bar schedule chip popover.
 */
export function ScheduledTaskList({
  rows,
  nowMs,
  className,
}: {
  rows: readonly ResolvedScheduledTask[];
  nowMs: number;
  className?: string;
}) {
  const { t } = useTranslation();
  const formatFireTime = useFireTimeFormatter();
  const relativeFireLabel = useRelativeFireLabel();

  return (
    <ul
      className={cn(
        'scrollbar-pro flex max-h-52 flex-col gap-1.5 overflow-y-auto text-xs',
        className
      )}
    >
      {rows.map(({ task, fireMs }) => {
        const isWakeup = task.kind === 'wakeup';
        const timeLabel = fireMs !== undefined ? formatFireTime(fireMs, nowMs) : undefined;
        const countdown = fireMs !== undefined ? relativeFireLabel(fireMs, nowMs) : undefined;
        return (
          <li key={task.id} className="flex items-start gap-2">
            {/* Fire time, left-aligned. Falls back to a kind icon when unresolved. */}
            {timeLabel ? (
              <time className="w-[3.25rem] shrink-0 pt-px text-right font-medium tabular-nums text-foreground">
                {timeLabel}
              </time>
            ) : (
              <span className="flex w-[3.25rem] shrink-0 justify-end pt-0.5">
                {isWakeup ? (
                  <AlarmClock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                ) : (
                  <CalendarClock
                    className="h-3.5 w-3.5 text-muted-foreground"
                    aria-hidden="true"
                  />
                )}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-muted-foreground">
                <span className="font-medium text-foreground">
                  {isWakeup
                    ? t('sessions.scheduledTasks.wakeupLabel')
                    : t('sessions.scheduledTasks.cronLabel')}
                </span>
                {countdown ? <span>· {countdown}</span> : null}
                {!isWakeup && task.recurring ? (
                  <span className="inline-flex items-center gap-0.5">
                    <Repeat className="h-3 w-3" aria-hidden="true" />
                    {t('sessions.scheduledTasks.recurring')}
                  </span>
                ) : null}
              </div>
              {task.summary ? (
                <div className="break-words text-muted-foreground">{task.summary}</div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
