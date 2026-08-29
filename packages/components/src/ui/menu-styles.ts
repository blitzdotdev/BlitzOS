import type { CSSProperties } from 'react';

export const menuSurfaceClassName = 'rounded-xl border bg-background p-1.5 text-foreground';

// The menu's edge color: a fixed small step from the *surface* (--background)
// toward the foreground. Derive it from --background rather than --border
// because per-theme --border is tuned for elevated cards/popovers and can clash
// hard against --background (e.g. Vesper's bright border over its near-black
// background). Shared by the outer border and the inner separators so they read
// as the same line in every theme.
const menuEdgeColor = 'color-mix(in oklab, hsl(var(--background)) 90%, hsl(var(--foreground)) 10%)';

export const menuSurfaceStyle: CSSProperties = {
  // Match the app's main background so the menu reads as the same surface;
  // the border is what separates it from the page.
  backgroundColor: 'hsl(var(--background))',
  borderColor: menuEdgeColor,
  boxShadow: '0 8px 24px -10px rgb(0 0 0 / 0.18), 0 2px 6px -3px rgb(0 0 0 / 0.1)',
};

export const menuItemClassName =
  "relative flex cursor-default select-none items-center gap-2 rounded-lg px-2.5 py-2 text-[0.8rem] outline-hidden focus:bg-hover focus:text-hover-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-']):not([class*='h-']):not([class*='w-'])]:size-4";

export const menuSelectionItemClassName =
  'relative flex cursor-default select-none items-center rounded-lg py-2 pl-8 pr-2.5 text-[0.8rem] outline-hidden focus:bg-hover focus:text-hover-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50';

// Inset from the menu's padded edges (positive mx) so the line does not cut the
// full row; color matches the outer border via menuSeparatorStyle.
export const menuSeparatorClassName = 'mx-2 my-1 h-px';

export const menuSeparatorStyle: CSSProperties = {
  backgroundColor: menuEdgeColor,
};
