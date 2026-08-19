import { useEffect, useState, type ReactNode } from 'react';
import {
  previewLinkLabel,
  previewUrl,
  type LivePort,
  type PreviewLink,
} from './preview';

function OpenInTabGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6.5 3.5H3.6A1.1 1.1 0 0 0 2.5 4.6v7.8a1.1 1.1 0 0 0 1.1 1.1h7.8a1.1 1.1 0 0 0 1.1-1.1V9.5" /><path d="M9.8 2.5h3.7v3.7M13.2 2.8 7.6 8.4" /></svg>
  );
}

function TeenyappsSection({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  children?: ReactNode;
}) {
  return (
    <section className="teenyapps-section" aria-label={title}>
      <h3 className="teenyapps-heading">
        <span className="teenyapps-heading__name">{title}</span>
        {count > 0 && <span className="teenyapps-heading__count">{count}</span>}
      </h3>
      {count === 0
        ? <p className="teenyapps-empty">{empty}</p>
        : <div className="teenyapps-grid">{children}</div>}
    </section>
  );
}

/** Replaces the drawer's Previews section. Deployed teenyapps and the ports
 * this workspace is serving right now share one card shape; the live dot is
 * what says "running process", not "published artefact". */
export function TeenyappsPanel({
  orgName,
  workspaceId,
  livePorts,
  previewLinks,
  filesBase,
  previewReady,
  onOpenPreview,
  onOpenPreviewLink,
}: {
  orgName: string;
  workspaceId: string;
  livePorts: LivePort[];
  previewLinks: PreviewLink[];
  filesBase: string | null;
  previewReady: boolean;
  onOpenPreview: (port: number) => void;
  onOpenPreviewLink: (url: string, title: string) => void;
}) {
  const [openedPort, setOpenedPort] = useState<number | null>(null);
  const [previewNonce, setPreviewNonce] = useState(0);
  useEffect(() => {
    setOpenedPort(null);
  }, [workspaceId]);

  if (openedPort !== null) {
    return (
      <div className="workspace-preview-open">
        <div className="workspace-preview-bar">
          <button
            className="fnd-tbtn"
            type="button"
            aria-label="Back to teenyapps"
            onClick={() => setOpenedPort(null)}
          >
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 3 5 8l5 5" /></svg>
          </button>
          <button
            className="fnd-tbtn"
            type="button"
            aria-label="Reload preview"
            onClick={() => setPreviewNonce((nonce) => nonce + 1)}
          >
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.2-3.2" /><path d="M13 2.6v2.6h-2.6" /></svg>
          </button>
          <span className="workspace-preview-addr">
            <span className="workspace-preview-addr-text">
              {livePorts.find((entry) => entry.port === openedPort)?.process ?? 'stopped'}
              {' · '}
              <b>:{openedPort}</b>
            </span>
          </span>
          <button
            className="fnd-tbtn"
            type="button"
            aria-label="Open as a workspace tab"
            title="Open as a workspace tab"
            onClick={() => onOpenPreview(openedPort)}
          >
            <OpenInTabGlyph />
          </button>
        </div>
        {previewReady && filesBase !== null
          ? (
            <iframe
              key={previewNonce}
              className="workspace-preview-frame"
              src={previewUrl(filesBase, openedPort)}
              title={`Preview :${openedPort}`}
              referrerPolicy="no-referrer"
            />
          )
          : <p className="workspace-drawer-state">Box is asleep.</p>}
      </div>
    );
  }

  return (
    <section className="workspace-drawer-panel teenyapps" aria-label="teenyapps">
      <TeenyappsSection
        title={orgName}
        count={0}
        empty="No teenyapps shared with this organization yet."
      />
      <TeenyappsSection
        title="My teenyapps"
        count={previewLinks.length}
        empty="Nothing deployed yet — publish from the terminal and it lands here."
      >
        {previewLinks.map((entry) => {
          const label = previewLinkLabel(entry.url, entry.title);
          let host = entry.url;
          try {
            host = new URL(entry.url).host;
          } catch {
            // A malformed link still deserves a card; the raw value is the label.
          }
          return (
            <button
              className="teenyapps-card"
              type="button"
              key={entry.url}
              aria-label={`Open ${label}`}
              onClick={() => onOpenPreviewLink(entry.url, entry.title)}
            >
              <span className="teenyapps-card__thumb">{host}</span>
              <span className="teenyapps-card__meta">
                <b>{label}</b>
                <span className="teenyapps-card__aside" aria-hidden="true">↗</span>
              </span>
            </button>
          );
        })}
      </TeenyappsSection>
      <TeenyappsSection
        title="Local apps"
        count={livePorts.length}
        empty="Ports this workspace is serving show up here while they run."
      >
        {livePorts.map((entry) => (
          <button
            className="teenyapps-card"
            type="button"
            key={entry.port}
            aria-label={`Open preview of ${entry.process}`}
            onClick={() => setOpenedPort(entry.port)}
          >
            <span className="teenyapps-card__thumb">
              {previewReady && filesBase !== null && (
                <iframe
                  className="workspace-preview-thumb"
                  src={previewUrl(filesBase, entry.port)}
                  title={`Preview of ${entry.process}`}
                  tabIndex={-1}
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  onLoad={(event) => {
                    event.currentTarget.classList.add('workspace-preview-thumb--ready');
                  }}
                />
              )}
              <span className="teenyapps-card__host">localhost:{entry.port}</span>
              <span className="teenyapps-card__badge">
                <span className="teenyapps-live" aria-hidden="true" />
                live
              </span>
            </span>
            <span className="teenyapps-card__meta">
              <b>{entry.process}</b>
              <span className="teenyapps-card__aside">:{entry.port}</span>
            </span>
          </button>
        ))}
      </TeenyappsSection>
    </section>
  );
}
