import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';

/**
 * Page-scope class for the Tasks workspace.
 *
 * Light mode: overrides design tokens to a cooler neutral ladder so cream/
 * warm canvas + pure-white menus stop fighting (see `index.css`, gated with
 * `:root:not(.dark) .tasks-surface`).
 *
 * Dark mode: no private palette. Tokens inherit the active VS Code theme
 * (same as the conversation surface) so Tasks does not become a blue-navy
 * island with mismatched accents.
 *
 * Portaled menus do not inherit this scope — use `tasksMenuContentProps` on
 * DropdownMenuContent / SubContent instead.
 */
export const TASKS_SURFACE_CLASS = 'tasks-surface';

/** Class + inline surface style that wins over the shared menuSurfaceStyle. */
export const TASKS_MENU_CLASS = 'tasks-menu';

export const tasksMenuSurfaceStyle: CSSProperties = {
  backgroundColor: 'hsl(var(--tasks-menu-bg))',
  borderColor: 'hsl(var(--tasks-menu-border))',
  boxShadow: 'var(--tasks-menu-shadow)',
};

export const tasksMenuContentProps = {
  className: TASKS_MENU_CLASS,
  style: tasksMenuSurfaceStyle,
} as const;

export function tasksMenuClassName(...parts: Array<string | undefined | false | null>): string {
  return cn(TASKS_MENU_CLASS, ...parts);
}
