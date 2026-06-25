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

export const IconCheck = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M5 12.5l4.2 4.2L19 6.8" />
  </Svg>
)
