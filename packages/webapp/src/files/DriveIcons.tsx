/* Inline glyphs lifted from plans/mockups/folders-v1-library.html so the Files
 * surface stays self-contained; every icon inherits currentColor. */

function glyph(path: React.ReactNode, filled = false) {
  return function Icon() {
    return (
      <svg
        viewBox="0 0 24 24"
        fill={filled ? 'currentColor' : 'none'}
        stroke={filled ? undefined : 'currentColor'}
        strokeWidth={filled ? undefined : 1.6}
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

export const DriveGlyph = glyph(
  <path d="M3 7.6a2 2 0 0 1 2-2h3.7a2 2 0 0 1 1.5.7l1.1 1.3H19a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
);

export const TemplateGlyph = glyph(
  <>
    <rect x="7.6" y="3.6" width="12.8" height="12.8" rx="2" />
    <path d="M16.4 16.4v2a2 2 0 0 1-2 2H5.6a2 2 0 0 1-2-2V7.6a2 2 0 0 1 2-2h2" />
  </>,
);

/** Play-in-circle: a recipe is a saved invocation one click away from running. */
export const RecipeGlyph = glyph(
  <>
    <circle cx="12" cy="12" r="8.4" />
    <path d="m10.2 8.9 5 3.1-5 3.1z" />
  </>,
);

export const FolderGlyph = glyph(
  <path d="M3.4 7.4a2 2 0 0 1 2-2h3.3a2 2 0 0 1 1.5.7l1.2 1.4h7.2a2 2 0 0 1 2 2v7.4a2 2 0 0 1-2 2H5.4a2 2 0 0 1-2-2z" />,
  true,
);

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

export const KebabGlyph = glyph(
  <>
    <circle cx="12" cy="5.4" r="1.7" />
    <circle cx="12" cy="12" r="1.7" />
    <circle cx="12" cy="18.6" r="1.7" />
  </>,
  true,
);

export const LinkGlyph = glyph(
  <>
    <path d="M10.2 13.8 13.8 10.2" />
    <path d="M11.2 7.4 13.6 5a4.1 4.1 0 0 1 5.8 5.8L17 13.2" />
    <path d="M12.8 16.6 10.4 19a4.1 4.1 0 0 1-5.8-5.8L7 10.8" />
  </>,
);

export const SearchGlyph = glyph(
  <>
    <circle cx="10.8" cy="10.8" r="6.2" />
    <path d="m15.4 15.4 4 4" />
  </>,
);

export const PlusGlyph = glyph(<path d="M12 5.2v13.6M5.2 12h13.6" />);

export const UploadGlyph = glyph(
  <>
    <path d="M12 16V4.8M7.6 9.2 12 4.8l4.4 4.4" />
    <path d="M4.6 15.4v2.6a2 2 0 0 0 2 2h10.8a2 2 0 0 0 2-2v-2.6" />
  </>,
);

export const DownloadGlyph = glyph(
  <>
    <path d="M12 4.8V16M7.6 11.6 12 16l4.4-4.4" />
    <path d="M4.6 15.4v2.6a2 2 0 0 0 2 2h10.8a2 2 0 0 0 2-2v-2.6" />
  </>,
);

export const FolderPlusGlyph = glyph(
  <>
    <path d="M3.4 7.4a2 2 0 0 1 2-2h3.3a2 2 0 0 1 1.5.7l1.2 1.4h7.2a2 2 0 0 1 2 2v7.4a2 2 0 0 1-2 2H5.4a2 2 0 0 1-2-2z" />
    <path d="M12 11.4v5M9.5 13.9h5" />
  </>,
);

export const PencilGlyph = glyph(
  <path d="M15.6 4.9 19.1 8.4 8.5 19H5v-3.5z" />,
);

export const TrashGlyph = glyph(
  <>
    <path d="M4.8 6.8h14.4M9.4 6.8V4.9h5.2v1.9" />
    <path d="M6.7 6.8 7.6 19a1.4 1.4 0 0 0 1.4 1.3h6a1.4 1.4 0 0 0 1.4-1.3l.9-12.2" />
  </>,
);

export const CloseGlyph = glyph(<path d="m6.4 6.4 11.2 11.2M17.6 6.4 6.4 17.6" />);

export const BackGlyph = glyph(<path d="M14.5 5.5 8 12l6.5 6.5" />);

export const CheckGlyph = glyph(<path d="m5 12.6 4.6 4.6L19 6.8" />);
