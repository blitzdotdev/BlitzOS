import type { CSSProperties } from 'react';

/**
 * Presentation colors for task labels. Labels are still stored as plain
 * normalized strings (no per-label color field yet); color is derived so the
 * picker and pills look like Linear without a workspace label registry.
 *
 * Suggested labels get fixed hues that match common issue trackers. Everything
 * else hashes onto a short palette so the same name is always the same color.
 */

/** HSL components without the `hsl()` wrapper, e.g. `"0 80% 58%"`. */
export type TaskLabelHsl = string;

/**
 * Linear-adjacent palette: saturated mid-lightness so the same values stay
 * readable as text and dots on both light and dark surfaces.
 */
export const TASK_LABEL_COLOR_PALETTE: readonly TaskLabelHsl[] = [
  '0 78% 58%', // red
  '24 90% 52%', // orange
  '42 92% 48%', // yellow
  '152 55% 40%', // green
  '188 70% 42%', // teal
  '214 78% 54%', // blue
  '262 68% 58%', // purple
  '310 62% 54%', // pink
  '330 72% 56%', // rose
  '210 12% 50%', // gray
] as const;

/** Fixed hues for the seeded suggestions in `@lody/shared`. */
const SUGGESTED_LABEL_COLORS: Readonly<Record<string, TaskLabelHsl>> = {
  bug: TASK_LABEL_COLOR_PALETTE[0]!,
  feature: TASK_LABEL_COLOR_PALETTE[6]!,
  document: TASK_LABEL_COLOR_PALETTE[5]!,
};

function hashLabelName(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/** Resolve a stable HSL color for a normalized label name. */
export function getTaskLabelHsl(label: string): TaskLabelHsl {
  const key = label.trim().toLowerCase();
  const suggested = SUGGESTED_LABEL_COLORS[key];
  if (suggested) return suggested;
  const palette = TASK_LABEL_COLOR_PALETTE;
  return palette[hashLabelName(key) % palette.length]!;
}

/** Inline styles for the solid color dot in the labels menu. */
export function taskLabelDotStyle(label: string): CSSProperties {
  return { backgroundColor: `hsl(${getTaskLabelHsl(label)})` };
}

/** Inline styles for the filled pill chip shown on the properties row. */
export function taskLabelPillStyle(label: string): CSSProperties {
  const hsl = getTaskLabelHsl(label);
  return {
    color: `hsl(${hsl})`,
    borderColor: `hsl(${hsl} / 0.38)`,
    backgroundColor: `hsl(${hsl} / 0.12)`,
  };
}
