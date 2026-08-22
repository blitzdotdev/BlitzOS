import type {
  CatalogEntryView,
  ConnectionView,
  PutConnectionRequest,
  TemplateConnectionView,
} from '@blitzos/schema';
import { useState } from 'react';
import type { ControlPlaneClient } from '../api';
import {
  orgCredentialFor,
  ProviderAdminForm,
} from '../connections/ProviderAdminForm';

/** The template's connections picker plus the org-credential surface. A
 * template names providers; members supply their own identity inside each
 * workspace — except admin-configured providers, whose one org credential is
 * stored right here when the provider gets attached. */
export function TemplateConnectionsSection({
  client,
  admin,
  catalog,
  orgConnections,
  onOrgConnections,
  value,
  onChange,
}: {
  client: Pick<ControlPlaneClient, 'putConnection' | 'listConnections'>;
  admin: boolean;
  catalog: CatalogEntryView[];
  orgConnections: ConnectionView[];
  onOrgConnections: (connections: ConnectionView[]) => void;
  value: Map<string, TemplateConnectionView>;
  onChange: (
    update: (
      current: Map<string, TemplateConnectionView>,
    ) => Map<string, TemplateConnectionView>,
  ) => void;
}) {
  const templateConnections = value;
  const setTemplateConnections = onChange;
  /** Provider whose replace-credential form is open (configured ones only;
   * an unconfigured admin provider shows its form unprompted). */
  const [configuring, setConfiguring] = useState<string | null>(null);
  const [savingConnection, setSavingConnection] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  /** Stores the org credential for an admin-configured provider. The PUT is
   * the same route the settings panel used to submit; only the mount moved —
   * the credential is configured where the provider gets attached. */
  const saveOrgConnection = async (entry: CatalogEntryView, input: PutConnectionRequest) => {
    if (savingConnection) return;
    setSavingConnection(true);
    setConnectionError(null);
    try {
      await client.putConnection(entry.id, input);
      const { connections } = await client.listConnections();
      onOrgConnections(connections);
      setConfiguring(null);
    } catch (caught) {
      setConnectionError(caught instanceof Error
        ? caught.message
        : 'Saving the connection failed.');
    } finally {
      setSavingConnection(false);
    }
  };

  return (
    <div className="tplf-connections">
      <h2>Connections</h2>
      <p>
        Named here, connected by members inside each workspace from
        its connections panel. Required ones read as needs-you there;
        creation never blocks. Admin-configured providers store one
        organization credential right here instead.
      </p>
      {connectionError && (
        <p className="webapp-form-message" role="alert">{connectionError}</p>
      )}
      {catalog.map((entry) => {
        const chosen = templateConnections.get(entry.id) ?? null;
        const configured = orgCredentialFor(orgConnections, entry.id);
        // The admin-credential surface mounts where the provider is
        // attached: an unconfigured admin provider opens its form the
        // moment an admin ticks it; members learn who to ask.
        const wantsOrgConfig = chosen !== null && entry.adminForm !== null;
        const formOpen = wantsOrgConfig && admin
          && (!configured || configuring === entry.id);
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
                    if (checked) next.set(entry.id, { provider: entry.id, required: false });
                    else next.delete(entry.id);
                    return next;
                  });
                }}
              />
              <span>{entry.title}</span>
              {wantsOrgConfig && configured && (
                <em className="tplf-chip tplf-chip--attached">org credential</em>
              )}
              {chosen !== null && (
                <button
                  className="webapp-action"
                  type="button"
                  aria-pressed={chosen.required}
                  onClick={() => setTemplateConnections((current) => {
                    const next = new Map(current);
                    next.set(entry.id, { provider: entry.id, required: !chosen.required });
                    return next;
                  })}
                >{chosen.required ? 'Required' : 'Optional'}</button>
              )}
              {wantsOrgConfig && admin && configured && configuring !== entry.id && (
                <button
                  className="webapp-action"
                  type="button"
                  onClick={() => setConfiguring(entry.id)}
                >Replace credential</button>
              )}
            </label>
            {wantsOrgConfig && !admin && !configured && (
              <p className="tplf-connection-note">
                Ask an organization admin to configure {entry.title}:
                its credential is stored once, right here on the
                template page, and reaches every workspace.
              </p>
            )}
            {formOpen && (
              <ProviderAdminForm
                entry={entry}
                saving={savingConnection}
                configured={configured}
                onCancel={() => {
                  // Cancelling an unconfigured provider's form also
                  // detaches it: attached-but-unconfigured is exactly
                  // the state this surface exists to prevent.
                  setConfiguring(null);
                  if (!configured) {
                    setTemplateConnections((current) => {
                      const next = new Map(current);
                      next.delete(entry.id);
                      return next;
                    });
                  }
                }}
                onSubmit={(input) => { void saveOrgConnection(entry, input); }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
