/* Glyphs lifted verbatim from plans/mockups/session-rail.html so the strip and
 * the rail draw the shapes the mockup specifies. Every path inherits
 * currentColor and sits on the mockup's 16×16 grid. */

function glyph(path: React.ReactNode, strokeWidth = 1.4) {
  return function Icon({ className }: { className?: string }) {
    return (
      <svg
        className={className}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        {path}
      </svg>
    );
  };
}

export const PlusGlyph = glyph(<path d="M8 3.5v9M3.5 8h9" />, 1.7);

/* Drive wears the folder outline the Drive surface already draws
 * (files/DriveIcons.tsx `DriveGlyph`), on the strip's 16-grid. */
export const DriveGlyph = glyph(
  <path d="M2 4.5A1.5 1.5 0 013.5 3h2.6l1.4 1.8h5A1.5 1.5 0 0114 6.3v6.2A1.5 1.5 0 0112.5 14h-9A1.5 1.5 0 012 12.5z" />,
);

export const ShareGlyph = glyph(
  <>
    <circle cx="11.5" cy="4" r="2" />
    <circle cx="4.5" cy="8" r="2" />
    <circle cx="11.5" cy="12" r="2" />
    <path d="M6.3 7l3.4-2M6.3 9l3.4 2" />
  </>,
);
