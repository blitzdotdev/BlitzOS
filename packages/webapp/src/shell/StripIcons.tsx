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
