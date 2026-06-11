/* Thin-line icon set, Spatial-style: 24px grid, currentColor stroke, rounded caps.
   Sized by CSS (.window-ico svg, .sidebar-app svg, …) or the `size` prop. */
import type { SVGProps, ReactNode } from 'react'

function Svg({ size = 18, children, ...rest }: { size?: number; children: ReactNode } & SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {children}
    </svg>
  )
}

type P = { size?: number }

export const IconPlus = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)
export const IconClose = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
)
export const IconEye = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z" />
    <circle cx="12" cy="12" r="2.5" />
  </Svg>
)
export const IconGlobe = (p: P): JSX.Element => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.5 2.5 3.5 5.8 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.8-3.5-9s1-6.5 3.5-9Z" />
  </Svg>
)
export const IconGrid = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" />
  </Svg>
)
export const IconFolder = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9Z" />
  </Svg>
)
export const IconBoard = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-11Z" />
    <path d="M9 4v16M15 4v16M4 10h16M4 15h16" />
  </Svg>
)
export const IconCode = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M9 8l-4 4 4 4M15 8l4 4-4 4" />
  </Svg>
)
export const IconNote = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7l-4-4Z" />
    <path d="M14 3v4h4M9 13h6M9 17h4" />
  </Svg>
)
export const IconChat = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M21 11.5a8.5 8.5 0 0 1-12.3 7.6L3 21l1.9-5.7A8.5 8.5 0 1 1 21 11.5Z" />
  </Svg>
)
export const IconSparkle = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" />
  </Svg>
)
export const IconChevronDown = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M6 9l6 6 6-6" />
  </Svg>
)
export const IconLock = (p: P): JSX.Element => (
  <Svg {...p}>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V7.5a4 4 0 0 1 8 0V11" />
  </Svg>
)
export const IconLockOpen = (p: P): JSX.Element => (
  <Svg {...p}>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V7.5a4 4 0 0 1 7-2.3" />
  </Svg>
)

/** Surface-kind glyph for the dock. */
export function KindIcon({ kind, size }: { kind: string; size?: number }): JSX.Element {
  if (kind === 'web') return <IconGlobe size={size} />
  if (kind === 'app') return <IconGrid size={size} />
  if (kind === 'srcdoc') return <IconCode size={size} />
  return <IconNote size={size} />
}
