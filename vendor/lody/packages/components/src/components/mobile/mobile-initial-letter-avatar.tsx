import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/* Deterministic 0–359 hue from a string. Tiny FNV-ish hash; collisions
   are fine because we only need visual variety, not uniqueness. */
function stringToHue(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

export type MobileInitialLetterAvatarSize = 'sm' | 'md' | 'lg';

const SIZE_CLASSNAMES: Record<MobileInitialLetterAvatarSize, string> = {
  /* Header chip — paired with `text-base` titles. */
  sm: 'h-6 w-6 rounded-md text-[0.72rem]',
  /* Default — used in the project header next to a `text-[0.98rem]` title. */
  md: 'h-7 w-7 rounded-lg text-[0.82rem]',
  /* Home row leading tile. */
  lg: 'h-10 w-10 rounded-xl text-[1.05rem]',
};

/**
 * Default avatar for any "named entity without its own image" surface
 * (local projects, chat-only sessions, etc). Renders the first letter
 * of `name` on a solid saturated background whose hue is derived from
 * `hashSeed` so each entity gets a stable color across renders. Solid
 * bg + white foreground reads in both light + dark themes without
 * per-theme CSS.
 *
 * Pass `hashSeed` distinctly when the same `name` should still produce
 * different hues per entity (e.g. two projects named "lody" on
 * different machines — use the unique id as the seed).
 */
export function MobileInitialLetterAvatar({
  name,
  hashSeed,
  size = 'md',
  fallbackIcon,
  className,
}: {
  name: string;
  hashSeed: string;
  size?: MobileInitialLetterAvatarSize;
  fallbackIcon?: ReactNode;
  className?: string;
}) {
  const trimmed = name.trim();
  const initial = trimmed.length > 0 ? Array.from(trimmed)[0]!.toUpperCase() : null;
  const hue = stringToHue(hashSeed || name);
  return (
    <span
      style={{ backgroundColor: `hsl(${hue} 62% 52%)` }}
      className={cn(
        'inline-flex shrink-0 items-center justify-center font-semibold text-white',
        SIZE_CLASSNAMES[size],
        className
      )}
      aria-hidden="true"
    >
      {initial ?? fallbackIcon}
    </span>
  );
}
