import type { SVGProps } from 'react';

type CockpitIconProps = SVGProps<SVGSVGElement>;

export function CodexIcon(props: CockpitIconProps) {
  return (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true" {...props}>
      <path d="M6 1.2 10.8 6 6 10.8 1.2 6Z" />
    </svg>
  );
}

export function ShellIcon(props: CockpitIconProps) {
  return (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true" {...props}>
      <path d="M2 2.6 5.4 6 2 9.4" />
      <path d="M6.6 9.4h3.4" />
    </svg>
  );
}

export function FileIcon(props: CockpitIconProps) {
  return (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.15" aria-hidden="true" {...props}>
      <path d="M2.25 1.25h4.6l2.9 2.9v6.6h-7.5Z" />
      <path d="M6.75 1.45v2.9h2.8" />
    </svg>
  );
}

export function FolderIcon(props: CockpitIconProps) {
  return (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.15" aria-hidden="true" {...props}>
      <path d="M1.25 3h3.5l1-1.25h5v8.5h-9.5Z" />
    </svg>
  );
}

export function FolderOpenIcon(props: CockpitIconProps) {
  return (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.15" aria-hidden="true" {...props}>
      <path d="M1.25 3h3.5l1-1.25h5v2.1" />
      <path d="M1.25 4.1h10l-1.4 6.15H2.4Z" />
    </svg>
  );
}

export function ChevronIcon(props: CockpitIconProps) {
  return (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.35" aria-hidden="true" {...props}>
      <path d="m4.25 2.5 3.5 3.5-3.5 3.5" />
    </svg>
  );
}
