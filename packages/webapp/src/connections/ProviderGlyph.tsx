import type { SVGProps } from 'react';
import { GenericProviderIcon } from '../WebAppIcons';

/** Brand marks for the connection catalog, keyed by the manifest id the
 * control plane sends. They are monochrome and paint with currentColor, so one
 * glyph works in every row, chip, and panel the picker renders. A provider
 * without a mark here falls back to the generic one rather than to nothing. */

type GlyphProps = SVGProps<SVGSVGElement>;

function GithubGlyph(props: GlyphProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 .5C5.73.5.64 5.59.64 11.87c0 5.02 3.26 9.28 7.78 10.78.57.11.78-.25.78-.55l-.02-1.93c-3.16.69-3.83-1.52-3.83-1.52-.52-1.32-1.27-1.67-1.27-1.67-1.03-.71.08-.69.08-.69 1.14.08 1.74 1.17 1.74 1.17 1.01 1.74 2.66 1.24 3.31.95.1-.74.4-1.24.72-1.52-2.52-.29-5.18-1.27-5.18-5.64 0-1.25.44-2.27 1.16-3.06-.12-.29-.5-1.45.11-3.02 0 0 .95-.31 3.11 1.17a10.7 10.7 0 0 1 5.66 0c2.16-1.48 3.11-1.17 3.11-1.17.62 1.57.23 2.73.11 3.02.72.79 1.16 1.81 1.16 3.06 0 4.38-2.67 5.35-5.2 5.63.41.36.78 1.06.78 2.14l-.01 3.17c0 .3.2.66.79.55a11.38 11.38 0 0 0 7.77-10.78C23.36 5.59 18.27.5 12 .5Z" />
    </svg>
  );
}

function GoogleGlyph(props: GlyphProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12.24 10.29v3.5h5.02c-.22 1.3-.88 2.4-1.87 3.14l3.02 2.34c1.76-1.62 2.78-4.02 2.78-6.87 0-.66-.06-1.3-.17-1.92l-8.78-.19Z" />
      <path d="M12.24 21.6c2.52 0 4.63-.83 6.17-2.25l-3.02-2.34c-.84.56-1.9.9-3.15.9-2.43 0-4.49-1.64-5.22-3.84l-3.12 2.4A9.36 9.36 0 0 0 12.24 21.6Z" />
      <path d="M7.02 14.07a5.6 5.6 0 0 1 0-3.58l-3.12-2.4a9.35 9.35 0 0 0 0 8.38l3.12-2.4Z" />
      <path d="M12.24 6.62c1.37 0 2.6.47 3.57 1.39l2.67-2.67A9.36 9.36 0 0 0 3.9 8.09l3.12 2.4c.73-2.2 2.79-3.87 5.22-3.87Z" />
    </svg>
  );
}

function LinearGlyph(props: GlyphProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M0.72 14.9 9.1 23.28A12.03 12.03 0 0 1 .72 14.9ZM.1 11.75l12.15 12.15c-.6-.03-1.18-.11-1.75-.24L.34 13.5a12 12 0 0 1-.24-1.75ZM.62 8.2l15.18 15.18c-.83.3-1.7.5-2.6.6L.02 10.8c.1-.9.3-1.77.6-2.6ZM2.14 5.2 18.8 21.86a12.1 12.1 0 0 1-2.03 1.24L.9 7.23c.33-.72.75-1.4 1.24-2.03ZM21.4 19.65 4.35 2.6a12 12 0 0 1 17.05 17.05Z" />
    </svg>
  );
}

function DiscordGlyph(props: GlyphProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M19.63 5.33a17.6 17.6 0 0 0-4.35-1.35l-.21.42c-.18.35-.39.81-.53 1.16a16.2 16.2 0 0 0-4.99 0 12.4 12.4 0 0 0-.55-1.16l-.2-.42a17.6 17.6 0 0 0-4.35 1.35C1.72 9.24.9 13.05 1.19 16.8a17.7 17.7 0 0 0 5.36 2.71c.43-.59.81-1.21 1.14-1.86a11.4 11.4 0 0 1-1.79-.86l.44-.35a12.6 12.6 0 0 0 11.32 0l.45.35c-.57.34-1.17.63-1.8.86.33.65.71 1.27 1.15 1.86a17.6 17.6 0 0 0 5.36-2.71c.34-4.35-.97-8.13-3.19-11.47ZM8.32 14.53c-1.05 0-1.92-.96-1.92-2.15 0-1.18.84-2.15 1.92-2.15 1.09 0 1.95.97 1.93 2.15 0 1.19-.85 2.15-1.93 2.15Zm7.09 0c-1.05 0-1.92-.96-1.92-2.15 0-1.18.85-2.15 1.92-2.15 1.09 0 1.95.97 1.93 2.15 0 1.19-.84 2.15-1.93 2.15Z" />
    </svg>
  );
}

function YoutrackGlyph(props: GlyphProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" aria-hidden="true" {...props}>
      <path d="M6.5 2h11A4.5 4.5 0 0 1 22 6.5v11a4.5 4.5 0 0 1-4.5 4.5h-11A4.5 4.5 0 0 1 2 17.5v-11A4.5 4.5 0 0 1 6.5 2ZM6.4 6.6h2.4L12 9.8l3.2-3.2h2.4L13.2 11v6.4h-2.4V11Z" />
    </svg>
  );
}

/** The mark for one catalog provider. `provider` is the manifest id. */
export function ProviderGlyph({ provider, ...props }: GlyphProps & { provider: string }) {
  switch (provider) {
    case 'github': return <GithubGlyph {...props} />;
    case 'google-workspace': return <GoogleGlyph {...props} />;
    case 'linear': return <LinearGlyph {...props} />;
    case 'discord': return <DiscordGlyph {...props} />;
    case 'youtrack': return <YoutrackGlyph {...props} />;
    default: return <GenericProviderIcon {...props} />;
  }
}
