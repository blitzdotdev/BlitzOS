import type { SVGProps } from 'react';

/**
 * Linear-style priority glyphs: one silhouette family for the ladder, a special
 * urgent mark that is allowed to take color.
 *
 * Signal bars always draw three slots (short → tall). Level is fill vs idle
 * opacity of the same three bars — not bar *count* — so a list column reads as
 * one continuous scale at 14px. "No priority" uses the same three slots as
 * hollow strokes so empty and low stay distinguishable.
 */

const SVG_BASE = {
  xmlns: 'http://www.w3.org/2000/svg',
  width: '1em',
  height: '1em',
  viewBox: '0 0 16 16',
  fill: 'none',
} as const;

/** Three vertical bars, left→right short→tall. Bottom-aligned, 2.5-wide, 1.5 gap. */
const BARS: readonly { x: number; y: number; h: number }[] = [
  { x: 2, y: 9, h: 5 },
  { x: 6.75, y: 6, h: 8 },
  { x: 11.5, y: 3, h: 11 },
];

const BAR_WIDTH = 2.5;
const BAR_RX = 1;

function PriorityBars({
  filled,
  ...props
}: { filled: 0 | 1 | 2 | 3 } & SVGProps<SVGSVGElement>) {
  return (
    <svg {...SVG_BASE} {...props}>
      {BARS.map((bar, index) => {
        const active = index < filled;
        if (filled === 0) {
          // Hollow bars for "no priority" — same silhouette, no fill weight.
          return (
            <rect
              key={bar.x}
              x={bar.x}
              y={bar.y}
              width={BAR_WIDTH}
              height={bar.h}
              rx={BAR_RX}
              stroke="currentColor"
              strokeWidth={1.25}
              opacity={0.45}
            />
          );
        }
        return (
          <rect
            key={bar.x}
            x={bar.x}
            y={bar.y}
            width={BAR_WIDTH}
            height={bar.h}
            rx={BAR_RX}
            fill="currentColor"
            opacity={active ? 1 : 0.22}
          />
        );
      })}
    </svg>
  );
}

/** No priority — three hollow bars. */
export function LinearPriorityNone(props: SVGProps<SVGSVGElement>) {
  return <PriorityBars filled={0} {...props} />;
}

/** Low — first bar solid. */
export function LinearPriorityLow(props: SVGProps<SVGSVGElement>) {
  return <PriorityBars filled={1} {...props} />;
}

/** Medium — first two bars solid. */
export function LinearPriorityMedium(props: SVGProps<SVGSVGElement>) {
  return <PriorityBars filled={2} {...props} />;
}

/** High — all three bars solid. */
export function LinearPriorityHigh(props: SVGProps<SVGSVGElement>) {
  return <PriorityBars filled={3} {...props} />;
}

/**
 * Urgent — filled circle with a bang. Deliberately not a signal bar: it must
 * step out of the ladder so color (applied by the presentation layer) lands on
 * a shape people already read as "attention". The bang is an evenodd hole so it
 * stays transparent on hover/selected backgrounds (not a painted white mark).
 */
export function LinearPriorityUrgent(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...SVG_BASE} {...props}>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d={[
          // Outer disc.
          'M8 1.75a6.25 6.25 0 1 0 0 12.5a6.25 6.25 0 0 0 0-12.5z',
          // Bang stem (hole).
          'M7.4 4.45h1.2c.32 0 .58.26.56.58l-.22 3.95a.58.58 0 0 1-1.16 0L7.56 5.03A.57.57 0 0 1 7.4 4.45z',
          // Bang dot (hole).
          'M8 12.15a.8.8 0 1 0 0-1.6.8.8 0 0 0 0 1.6z',
        ].join('')}
      />
    </svg>
  );
}
