/* Thin-line icon set, Spatial-style: 24px grid, currentColor stroke, rounded caps.
   Sized by CSS (.window-ico svg, .sidebar-btn svg, …) or the `size` prop. */
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
export const IconMinus = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M5 12h14" />
  </Svg>
)
export const IconClose = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
)
export const IconReload = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M20 12a8 8 0 1 1-2.34-5.66" />
    <path d="M20 4v4h-4" />
  </Svg>
)
export const IconEye = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z" />
    <circle cx="12" cy="12" r="2.5" />
  </Svg>
)
export const IconMaximize = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M3 16v3a2 2 0 0 0 2 2h3" />
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
export const IconCrosshair = (p: P): JSX.Element => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
  </Svg>
)
export const IconReturn = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M9 10l-4 4 4 4" />
    <path d="M5 14h11a4 4 0 0 0 4-4V6" />
  </Svg>
)
export const IconArrowLeft = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M15 6l-6 6 6 6" />
  </Svg>
)

/** Surface-kind glyph for the dock. */
export function KindIcon({ kind, size }: { kind: string; size?: number }): JSX.Element {
  if (kind === 'web') return <IconGlobe size={size} />
  if (kind === 'app') return <IconGrid size={size} />
  if (kind === 'srcdoc') return <IconCode size={size} />
  return <IconNote size={size} />
}
