import { SessionTypeIcon } from './SessionTypeIcon';
import { previewLinkLabel, type LivePort, type PreviewLink } from './preview';

export type SpawnSessionType = 'claude' | 'codex' | 'terminal';

export const SPAWN_SESSION_LABELS = {
  claude: 'Claude',
  codex: 'Codex',
  terminal: 'Terminal',
} satisfies Record<SpawnSessionType, string>;

const SPAWN_SESSION_TYPES: SpawnSessionType[] = [
  'claude',
  'codex',
  'terminal',
];

/** What a new tab can be: a session to spawn, a live port, or a published
 * preview link. The tab strip's "+" and the session rail's pinned action both
 * render this one menu, so the two can never offer different things. Each call
 * site keeps its own anchor: it passes the positioning class and decides
 * whether the menu is mounted or merely hidden. */
export function NewTabMenu({
  className,
  hidden,
  livePorts = [],
  previewLinks = [],
  onSpawn,
  onOpenPreview,
  onOpenPreviewLink,
}: {
  className?: string;
  hidden?: boolean;
  livePorts?: LivePort[];
  previewLinks?: PreviewLink[];
  onSpawn: (type: SpawnSessionType) => void;
  onOpenPreview: (port: number) => void;
  onOpenPreviewLink: (url: string, title: string) => void;
}) {
  return (
    <div
      className={className === undefined ? 'webapp-agent-menu' : `webapp-agent-menu ${className}`}
      role="menu"
      aria-label="New tab"
      hidden={hidden}
    >
      {SPAWN_SESSION_TYPES.map((agent) => (
        <button type="button" role="menuitem" key={agent} onClick={() => onSpawn(agent)}>
          <SessionTypeIcon type={agent} className="webapp-new-menu-icon" />
          {SPAWN_SESSION_LABELS[agent]}
        </button>
      ))}
      {(livePorts.length > 0 || previewLinks.length > 0) && (
        <>
          <div className="webapp-agent-menu__separator" role="separator" />
          {livePorts.map((entry) => (
            <button
              type="button"
              role="menuitem"
              key={entry.port}
              onClick={() => onOpenPreview(entry.port)}
            >
              <SessionTypeIcon type="preview" className="webapp-new-menu-icon" />
              <span>:{entry.port}</span>
              <span className="webapp-agent-menu__process">{entry.process}</span>
            </button>
          ))}
          {previewLinks.map((entry) => (
            <button
              type="button"
              role="menuitem"
              key={entry.url}
              onClick={() => onOpenPreviewLink(entry.url, entry.title)}
            >
              <SessionTypeIcon type="preview" className="webapp-new-menu-icon" />
              <span>{previewLinkLabel(entry.url, entry.title)}</span>
              <span className="webapp-agent-menu__process">link</span>
            </button>
          ))}
        </>
      )}
    </div>
  );
}
