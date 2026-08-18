/** Editorial duotone icon set for the Finder-style files view: ink outline
 * with a soft accent wash (plans/mockups/workspace-tabs-editorial.html). */

const DOC_TINTS = new Map([
  ['html', 'var(--ansi-red)'], ['htm', 'var(--ansi-red)'],
  ['css', 'var(--ansi-cyan)'], ['scss', 'var(--ansi-magenta)'], ['less', 'var(--ansi-cyan)'],
  ['js', 'var(--ansi-yellow)'], ['mjs', 'var(--ansi-yellow)'], ['cjs', 'var(--ansi-yellow)'],
  ['jsx', 'var(--ansi-yellow)'], ['ts', 'var(--accent)'], ['tsx', 'var(--accent)'],
  ['mts', 'var(--accent)'], ['json', 'var(--muted)'], ['jsonl', 'var(--muted)'],
  ['yaml', 'var(--ansi-magenta)'], ['yml', 'var(--ansi-magenta)'], ['toml', 'var(--muted)'],
  ['md', 'var(--ansi-blue)'], ['markdown', 'var(--ansi-blue)'],
  ['py', 'var(--ansi-green)'], ['rb', 'var(--ansi-red)'], ['go', 'var(--ansi-cyan)'],
  ['rs', 'var(--ansi-red)'], ['java', 'var(--ansi-yellow)'], ['c', 'var(--accent)'],
  ['h', 'var(--accent)'], ['cpp', 'var(--accent)'],
  ['sh', 'var(--ansi-green)'], ['bash', 'var(--ansi-green)'],
  ['sql', 'var(--ansi-yellow)'], ['csv', 'var(--ansi-green)'],
  ['png', 'var(--ansi-magenta)'], ['jpg', 'var(--ansi-magenta)'], ['jpeg', 'var(--ansi-magenta)'],
  ['gif', 'var(--ansi-magenta)'], ['svg', 'var(--ansi-magenta)'], ['webp', 'var(--ansi-magenta)'],
  ['avif', 'var(--ansi-magenta)'], ['ico', 'var(--ansi-magenta)'],
  ['pdf', 'var(--ansi-red)'],
]);

function docTint(name: string): string {
  if (!name.includes('.')) return 'var(--muted)';
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  return DOC_TINTS.get(extension) ?? 'var(--muted)';
}

const CLOSED_FOLDER_PATH = 'M3.4 7.1c0-1 .8-1.8 1.8-1.8h3.2c.5 0 1 .2 1.3.6l1.1 1.1h7.9c1 0 1.8.8 1.8 1.8v7.9c0 1-.8 1.8-1.8 1.8H5.2c-1 0-1.8-.8-1.8-1.8z';

export function FolderDuoIcon({ open = false, className }: { open?: boolean; className?: string }) {
  if (!open) {
    return (
      <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
        <path d={CLOSED_FOLDER_PATH} fill="var(--accent)" opacity=".3" />
        <path d={CLOSED_FOLDER_PATH} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    );
  }
  const back = 'M4.7 7.2c0-.9.7-1.6 1.6-1.6H9c.5 0 .9.2 1.2.5l1.1 1.1h7c.9 0 1.6.7 1.6 1.6v1.4H4.7z';
  const front = 'M6.3 10.2h12.7c1 0 1.7.9 1.5 1.8l-1 4.4c-.2.9-1 1.5-1.9 1.5H4.9c-1 0-1.7-.9-1.5-1.8l1-4.4c.2-.9 1-1.5 1.9-1.5z';
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d={back} fill="var(--accent)" opacity=".3" />
      <path d={back} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d={front} fill="var(--accent)" opacity=".35" />
      <path d={front} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

/** Folder with a person badge — the shared root ("folder.badge.person.crop"). */
export function SharedFolderDuoIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d={CLOSED_FOLDER_PATH} fill="var(--accent)" opacity=".3" />
      <path d={CLOSED_FOLDER_PATH} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <circle cx="17.1" cy="16.1" r="5" fill="var(--accent)" />
      <circle cx="17.1" cy="14.7" r="1.6" fill="var(--paper)" />
      <path d="M14.5 18.6c.3-1.5 1.4-2.4 2.6-2.4 1.2 0 2.3.9 2.6 2.4a5 5 0 0 1-5.2 0z" fill="var(--paper)" />
      <circle cx="17.1" cy="16.1" r="5" fill="none" stroke="var(--paper)" strokeWidth="1.2" />
    </svg>
  );
}

export function DocDuoIcon({ name, className }: { name: string; className?: string }) {
  const body = 'M6.6 4.1c0-.9.7-1.6 1.6-1.6h5.3l4.3 4.3v13c0 .9-.7 1.6-1.6 1.6H8.2c-.9 0-1.6-.7-1.6-1.6z';
  const tint = docTint(name);
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d={body} fill={tint} opacity=".28" />
      <path d={body} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M13.3 2.8v3.1c0 .8.6 1.4 1.4 1.4h3.1" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M9.5 12.6h5.4M9.5 15.4h5.4M9.5 18.2h3.5" fill="none" stroke={tint} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** Duotone template glyph: same accent-wash treatment as the folder icons. */
export function TemplateDuoIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="7.6" y="3.6" width="12.8" height="12.8" rx="2" fill="var(--accent)" opacity=".3" />
      <rect x="3.6" y="7.6" width="12.8" height="12.8" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}
