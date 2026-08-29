import { useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronDown, Filter } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MobileFilterDrawer } from './mobile-filter-drawer';

/**
 * Reusable horizontal "filter chip" bar used by mobile views. Each pill
 * represents one filter dimension and opens an animated panel of
 * options beneath the bar when tapped.
 *
 * Two pill shapes are supported:
 *
 * - **single** — radio-style. The pill's label IS the selected
 *   option's label; tap an option to commit + auto-collapse the panel.
 * - **multi** — checkbox-style. The pill keeps its fixed label; tap
 *   options to toggle them in/out of the selection. A small "active"
 *   dot appears on the pill whenever the selection differs from the
 *   pill's `defaultIds` (i.e. "filter applied").
 *
 * The bar is intentionally *unaware* of what each filter does — it
 * just renders chips, manages panel open/close, and emits change
 * callbacks. Consumers wire the pill config + state and apply the
 * resulting filter however makes sense for their data.
 */

export type SingleSelectPill = {
  kind: 'single';
  /** Stable id, used as the React key + to determine which panel is
     open. Must be unique across the bar. */
  id: string;
  /** Fallback label if `selectedId` doesn't match any option (e.g.
     transient state during data refresh). */
  fallbackLabel: string;
  options: ReadonlyArray<{ id: string; label: string }>;
  selectedId: string;
  onSelect: (id: string) => void;
};

export type MultiSelectPillOption = {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Secondary text rendered under the label in a smaller, muted
     font. Use for paths, full names, or any "this is what it
     resolves to" detail that doesn't fit on the same line. */
  description?: ReactNode;
  /** Optional group key. Consecutive options sharing the same group
     value get a single muted section heading rendered above them
     in the dimension page (e.g. machine name above its local
     projects). Options are expected to be pre-sorted by group; the
     renderer doesn't re-group. */
  group?: string;
};

export type MultiSelectPill = {
  kind: 'multi';
  id: string;
  /** Fixed label shown on the pill regardless of selection. */
  label: string;
  options: ReadonlyArray<MultiSelectPillOption>;
  /** Currently-selected option ids. */
  selectedIds: ReadonlySet<string>;
  /** Ids representing the "no filter applied" baseline — usually
     every option. When `selectedIds` equals this set the pill is
     inactive and the active-dot indicator is suppressed. */
  defaultIds: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
};

/**
 * Collapses several `MultiSelectPill`s into one pill that opens a
 * drawer instead of the bar's inline panel. Used when the chip row
 * gets long enough that trailing chips fall off-screen — typically
 * 4+ filter dimensions on a phone — and the user stops noticing
 * them. The drawer presents a summary of active filters first,
 * then a tappable list to drill into each dimension.
 */
export type AggregateFilterPill = {
  kind: 'aggregate';
  id: string;
  /** Text shown on the pill, e.g. "过滤". */
  label: string;
  /** Inner dimensions rendered inside the drawer. */
  pills: ReadonlyArray<MultiSelectPill>;
  /** Optional override for the drawer's header title. Defaults to `label`. */
  drawerTitle?: string;
};

export type FilterPill = SingleSelectPill | MultiSelectPill | AggregateFilterPill;

export type MobileFilterPillBarProps = {
  pills: ReadonlyArray<FilterPill>;
  className?: string;
};

const PANEL_TRANSITION = { duration: 0.18, ease: [0.32, 0.72, 0, 1] as const };

export function MobileFilterPillBar({ pills, className }: MobileFilterPillBarProps) {
  const [openPillId, setOpenPillId] = useState<string | null>(null);
  const activePill = openPillId
    ? (pills.find((pill) => pill.id === openPillId) ?? null)
    : null;

  /* Inline accordion only renders for single / multi pills. Aggregate
     pills open their own drawer (rendered below). Splitting the
     branches here keeps the AnimatePresence height animation
     focused on the in-flow accordion case where it actually
     applies. */
  const inlineActivePill =
    activePill && activePill.kind !== 'aggregate' ? activePill : null;
  const aggregatePills = pills.filter(
    (pill): pill is AggregateFilterPill => pill.kind === 'aggregate'
  );

  return (
    <div className={cn('mobile-filter-pill-bar relative', className)}>
      <div
        role="toolbar"
        aria-label="filters"
        className="hide-scrollbar flex shrink-0 items-center gap-2 overflow-x-auto px-3 pt-2 pb-1.5"
      >
        {pills.map((pill) => (
          <FilterPillButton
            key={pill.id}
            pill={pill}
            isOpen={openPillId === pill.id}
            onToggle={() =>
              setOpenPillId((current) => (current === pill.id ? null : pill.id))
            }
          />
        ))}
      </div>
      <AnimatePresence initial={false}>
        {inlineActivePill ? (
          <motion.div
            key={inlineActivePill.id}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={PANEL_TRANSITION}
            className="overflow-hidden"
          >
            <PillOptionsPanel
              pill={inlineActivePill}
              onAfterSelect={() => {
                /* Single-select pills auto-collapse on commit so the
                   user doesn't have to dismiss. Multi-select pills
                   stay open so the user can toggle several options
                   without re-tapping the pill. */
                if (inlineActivePill.kind === 'single') setOpenPillId(null);
              }}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>
      {aggregatePills.map((aggregate) => (
        <MobileFilterDrawer
          key={aggregate.id}
          open={openPillId === aggregate.id}
          onOpenChange={(open) => setOpenPillId(open ? aggregate.id : null)}
          pills={aggregate.pills}
          title={aggregate.drawerTitle ?? aggregate.label}
        />
      ))}
    </div>
  );
}

function FilterPillButton({
  pill,
  isOpen,
  onToggle,
}: {
  pill: FilterPill;
  isOpen: boolean;
  onToggle: () => void;
}) {
  /* Aggregate pill has a distinct two-part chip shape: text + thin
     divider + filter icon (modeled on the standard mobile "Sort &
     filter" affordance in iOS Mail, Linear, Pinterest, etc.). Keep
     it visually separate from single/multi pills so users read
     "this opens a drawer" rather than "this is just another inline
     dropdown". */
  if (pill.kind === 'aggregate') {
    const hasActiveFilter = pill.pills.some(
      (inner) => !setsEqual(inner.selectedIds, inner.defaultIds)
    );
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        className={cn(
          'relative inline-flex shrink-0 items-center gap-2 rounded-full border py-1.5 pl-3 pr-2.5 text-[0.78rem] font-medium leading-none tracking-tight',
          'transition-colors active:scale-[0.97]',
          isOpen || hasActiveFilter
            ? 'border-primary/40 bg-primary/15 text-primary'
            : 'border-border/50 bg-muted text-foreground hover:bg-muted/80 dark:border-white/12 dark:bg-white/10 dark:hover:bg-white/14'
        )}
      >
        <span className="whitespace-nowrap">{pill.label}</span>
        <span
          aria-hidden="true"
          className={cn(
            'h-3.5 w-px',
            isOpen || hasActiveFilter ? 'bg-primary/30' : 'bg-border/70'
          )}
        />
        <Filter className="h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
        {hasActiveFilter ? (
          <span
            aria-hidden="true"
            className="absolute -right-0.5 -top-0.5 inline-block h-2 w-2 rounded-full bg-primary ring-2 ring-background"
          />
        ) : null}
      </button>
    );
  }

  let label: string;
  let hasFilterDot = false;

  if (pill.kind === 'single') {
    label = pill.options.find((opt) => opt.id === pill.selectedId)?.label ?? pill.fallbackLabel;
  } else {
    label = pill.label;
    hasFilterDot = !setsEqual(pill.selectedIds, pill.defaultIds);
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isOpen}
      aria-haspopup="listbox"
      className={cn(
        'relative inline-flex shrink-0 items-center gap-1 rounded-full border px-3 py-1.5 text-[0.78rem] font-medium leading-none tracking-tight',
        'transition-colors active:scale-[0.97]',
        isOpen
          ? 'border-primary/40 bg-primary/15 text-primary'
          : 'border-border/50 bg-muted text-foreground hover:bg-muted/80 dark:border-white/12 dark:bg-white/10 dark:hover:bg-white/14'
      )}
    >
      <span className="whitespace-nowrap">{label}</span>
      <ChevronDown
        className={cn(
          'h-3 w-3 shrink-0 transition-transform',
          isOpen ? 'rotate-180' : 'rotate-0'
        )}
        strokeWidth={2}
        aria-hidden="true"
      />
      {hasFilterDot ? (
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -top-0.5 inline-block h-2 w-2 rounded-full bg-primary ring-2 ring-background"
        />
      ) : null}
    </button>
  );
}

function PillOptionsPanel({
  pill,
  onAfterSelect,
}: {
  pill: SingleSelectPill | MultiSelectPill;
  onAfterSelect: () => void;
}) {
  if (pill.kind === 'single') {
    return (
      <div className="flex flex-wrap gap-1.5 px-3 pb-2.5 pt-1">
        {pill.options.map((option) => {
          const selected = option.id === pill.selectedId;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => {
                if (!selected) pill.onSelect(option.id);
                onAfterSelect();
              }}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[0.78rem] font-medium leading-none tracking-tight',
                'transition-colors active:scale-[0.97]',
                selected
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border/60 bg-card text-foreground hover:bg-muted/40'
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-1.5 px-3 pb-2.5 pt-1">
      {pill.options.map((option) => {
        const selected = pill.selectedIds.has(option.id);
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => {
              const next = new Set(pill.selectedIds);
              if (next.has(option.id)) next.delete(option.id);
              else next.add(option.id);
              pill.onChange(next);
            }}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[0.78rem] font-medium leading-none tracking-tight',
              'transition-colors active:scale-[0.97]',
              selected
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border/60 bg-card text-foreground hover:bg-muted/40'
            )}
          >
            {selected ? (
              <Check className="h-3 w-3 shrink-0" strokeWidth={2.4} aria-hidden="true" />
            ) : null}
            {option.icon}
            <span className="whitespace-nowrap">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function setsEqual<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}
