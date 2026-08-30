import type { SVGProps } from 'react';

/**
 * Worktree glyph (MingCute "brain" mark): a head outline with an internal
 * branch — the app's mark for a session running in an isolated git worktree.
 * Size it with the same height/width classes as a lucide icon; color comes
 * from currentColor.
 *
 * The native MingCute art only fills x:[4,20] y:[2,22] of its 24-box, so it
 * read small/thin next to lucide siblings; the viewBox is cropped to the art's
 * centered 20x20 bounds so it fills the icon slot at a matching visual weight.
 *
 * Icon from MingCute Icon by MingCute Design (Apache-2.0):
 * https://github.com/Richard9394/MingCute
 */
export function WorktreeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="1em"
      height="1em"
      viewBox="2 2 20 20"
      fill="none"
      aria-hidden="true"
      {...props}
    >
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M6.846 17.652c1.266.79 2.77 1.18 4.154 1.303V21a1 1 0 1 0 2 0v-2.045c1.383-.124 2.888-.514 4.154-1.303C18.783 16.637 20 14.96 20 12.5c0-2.584-1.412-5.18-2.98-7.075c-.796-.962-1.67-1.79-2.499-2.385C13.741 2.479 12.833 2 12 2s-1.74.479-2.521 1.04c-.83.596-1.704 1.423-2.5 2.385C5.413 7.319 4 9.916 4 12.5c0 2.46 1.217 4.137 2.846 5.152M8.52 6.7C7.088 8.43 6 10.584 6 12.5c0 1.682.783 2.756 1.904 3.455c.893.556 2.007.872 3.096.99v-2.53l-1.707-1.708a1 1 0 1 1 1.414-1.414l1.165 1.165l1.814-2.54a1 1 0 1 1 1.628 1.163L13 14.321v2.624c1.09-.118 2.203-.434 3.096-.99C17.217 15.255 18 14.182 18 12.5c0-1.916-1.088-4.07-2.52-5.8c-.705-.85-1.456-1.555-2.126-2.036C12.634 4.146 12.167 4 12 4s-.634.146-1.354.664c-.67.481-1.421 1.185-2.126 2.036"
      />
    </svg>
  );
}
