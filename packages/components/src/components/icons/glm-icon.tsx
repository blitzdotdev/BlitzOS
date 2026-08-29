import type { SVGProps } from 'react';

// The GLM / z.ai mark is a stylized "Z". We render only the glyph in
// `currentColor` (dropping the original logo's dark tile + gradients) so it
// stays monochrome and theme-aware, matching the other brand icons.
export function GlmIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="1em"
      height="1em"
      viewBox="0 0 30 30"
      aria-hidden="true"
      {...props}
    >
      <path
        fill="currentColor"
        d="M15.47 7.1l-1.3 1.85c-.2.29-.54.47-.9.47h-7.1V7.09C6.16 7.1 15.47 7.1 15.47 7.1z"
      />
      <path fill="currentColor" d="M24.3 7.1L13.14 22.91H5.7L16.86 7.1z" />
      <path fill="currentColor" d="M14.53 22.91l1.31-1.86c.2-.29.54-.47.9-.47h7.09v2.33H14.53z" />
    </svg>
  );
}
