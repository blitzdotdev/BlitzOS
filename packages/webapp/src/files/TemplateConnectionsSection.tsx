import type { CatalogEntryView, TemplateConnectionView } from '@blitzos/schema';
import { ProviderGlyph } from '../connections/ProviderGlyph';

/** The template's connections picker. A template names providers; members
 * supply their own identity inside each workspace. The org-credential form
 * that used to sit beside each admin-configured row is gone: an org-shared
 * key is an org credential now, stored in the org Credentials panel, never on
 * a connection row. */
export function TemplateConnectionsSection({
  catalog,
  value,
  onChange,
}: {
  catalog: CatalogEntryView[];
  value: Map<string, TemplateConnectionView>;
  onChange: (
    update: (
      current: Map<string, TemplateConnectionView>,
    ) => Map<string, TemplateConnectionView>,
  ) => void;
}) {
  const templateConnections = value;
  const setTemplateConnections = onChange;

  return (
    <div className="tplf-connections">
      <h2>Connections</h2>
      <p>Apps this template needs. Members connect each one inside their workspace, with their own token or through OAuth.</p>
      {catalog.map((entry) => {
        const chosen = templateConnections.get(entry.id) ?? null;
        return (
          <div className="tplf-connection-block" key={entry.id}>
            <label className="tplf-connection">
              <input
                type="checkbox"
                checked={chosen !== null}
                onChange={(event) => {
                  // Read before the updater runs: React nulls
                  // currentTarget once the handler returns.
                  const checked = event.currentTarget.checked;
                  setTemplateConnections((current) => {
                    const next = new Map(current);
                    if (checked) next.set(entry.id, { provider: entry.id });
                    else next.delete(entry.id);
                    return next;
                  });
                }}
              />
              <ProviderGlyph className="tplf-connection-glyph" provider={entry.id} />
              <span>{entry.title}</span>
            </label>
          </div>
        );
      })}
    </div>
  );
}
