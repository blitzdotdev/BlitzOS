import type { SVGProps } from 'react';

type WebAppIconProps = SVGProps<SVGSVGElement>;

export function CodexIcon(props: WebAppIconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" aria-hidden="true" {...props}>
      <path clipRule="evenodd" d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z" />
    </svg>
  );
}

export function ArrowIcon({
  direction,
  ...props
}: WebAppIconProps & { direction: 'up' | 'down' }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {direction === 'up'
        ? <path d="M12 19V5M6.5 10.5 12 5l5.5 5.5" />
        : <path d="M12 5v14m5.5-5.5L12 19l-5.5-5.5" />}
    </svg>
  );
}

export function OrganizationIcon(props: WebAppIconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <rect x="4.5" y="4.5" width="15" height="15" rx="2.5" />
      <circle cx="9.4" cy="9.4" r="1.7" />
      <circle cx="14.6" cy="9.4" r="1.7" />
      <circle cx="9.4" cy="14.6" r="1.7" />
      <circle cx="14.6" cy="14.6" r="1.7" />
    </svg>
  );
}

export function NewWorkspaceIcon(props: WebAppIconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="m10.5 5.25 6 3.35v6.8l-6 3.35-6-3.35V8.6Z" />
      <path d="m4.75 8.75 5.75 3.2 5.75-3.2M10.5 11.95v6.55" />
      <path d="M18.75 3.5v4M16.75 5.5h4" />
    </svg>
  );
}

export function WorkspaceIcon(props: WebAppIconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="m12 2.75 8 4.5v9.5l-8 4.5-8-4.5v-9.5Z" />
      <path d="m4.35 7.45 7.65 4.3 7.65-4.3M12 11.75v9" />
    </svg>
  );
}

export function ShellIcon(props: WebAppIconProps) {
  return (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true" {...props}>
      <path d="M2 2.6 5.4 6 2 9.4" />
      <path d="M6.6 9.4h3.4" />
    </svg>
  );
}

export function GenericProviderIcon(props: WebAppIconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="M10 2v2M7.5 2h5" />
      <rect x="2.5" y="4" width="15" height="12" rx="2" />
      <path d="M6.5 9h.01M13.5 9h.01M6.5 13h7M2.5 8H1M19 8h-1.5" />
    </svg>
  );
}

export function FileIcon(props: WebAppIconProps) {
  return (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.15" aria-hidden="true" {...props}>
      <path d="M2.25 1.25h4.6l2.9 2.9v6.6h-7.5Z" />
      <path d="M6.75 1.45v2.9h2.8" />
    </svg>
  );
}

export function FolderIcon(props: WebAppIconProps) {
  return (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.15" aria-hidden="true" {...props}>
      <path d="M1.25 3h3.5l1-1.25h5v8.5h-9.5Z" />
    </svg>
  );
}

