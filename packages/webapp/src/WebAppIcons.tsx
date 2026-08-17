import type { SVGProps } from 'react';

type WebAppIconProps = SVGProps<SVGSVGElement>;

export function CodexIcon(props: WebAppIconProps) {
  return (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true" {...props}>
      <path d="M6 1.2 10.8 6 6 10.8 1.2 6Z" />
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

export function FolderOpenIcon(props: WebAppIconProps) {
  return (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.15" aria-hidden="true" {...props}>
      <path d="M1.25 3h3.5l1-1.25h5v2.1" />
      <path d="M1.25 4.1h10l-1.4 6.15H2.4Z" />
    </svg>
  );
}

export function ChevronIcon(props: WebAppIconProps) {
  return (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.35" aria-hidden="true" {...props}>
      <path d="m4.25 2.5 3.5 3.5-3.5 3.5" />
    </svg>
  );
}

export function MoreIcon(props: WebAppIconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" {...props}>
      <circle cx="4" cy="10" r="1.5" />
      <circle cx="10" cy="10" r="1.5" />
      <circle cx="16" cy="10" r="1.5" />
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

