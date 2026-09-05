function glyph(path: React.ReactNode) {
  return function Icon({ className }: { className?: string } = {}) {
    return (
      <svg
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
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

export const BoxGlyph = glyph(
  <>
    <path d="M12 3.2 20 7.4v9.2L12 20.8 4 16.6V7.4z" />
    <path d="M4 7.4 12 11.6 20 7.4M12 11.6v9.2" />
  </>,
);

export const ShareGlyph = glyph(
  <>
    <circle cx="10" cy="8.2" r="3.2" />
    <path d="M4.2 19.4c.5-3.1 2.9-5 5.8-5 1 0 2 .2 2.8.7" />
    <path d="M17.4 14v6M14.4 17h6" />
  </>,
);
