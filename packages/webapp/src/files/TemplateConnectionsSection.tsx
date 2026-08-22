import type {
  CatalogEntryView,
  ConnectionView,
  PutConnectionRequest,
  TemplateConnectionView,
} from '@blitzos/schema';
import { useState } from 'react';
import type { ControlPlaneClient } from '../api';
import { ConfirmationDialog } from '../ConfirmationDialog';
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
  /** Provider whose config form was opened by an explicit click (Replace, or
   * the optional configure button on a member-path provider). */
  const [configuring, setConfiguring] = useState<string | null>(null);
  /** Provider whose Replace click awaits the org-wide blast-radius confirm. */
  const [confirmingReplace, setConfirmingReplace] = useState<CatalogEntryView | null>(null);
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
        its connections panel. Admin-configured providers store one
        organization credential right here instead.
      </p>
      {connectionError && (
        <p className="webapp-form-message" role="alert">{connectionError}</p>
      )}
      {catalog.map((entry) => {
        const chosen = templateConnections.get(entry.id) ?? null;
        const configured = orgCredentialFor(orgConnections, entry.id);
        const wantsOrgConfig = chosen !== null && entry.adminForm !== null;
        // A provider members can authorize themselves — OAuth or a token
        // paste — is usable without any org credential, so its admin form is
        // an offer, never a gate.
        const memberPath = entry.oauthAvailable || entry.personalTokenLabel !== null;
        // The form auto-opens only where the org credential is the sole path
        // (discord): attaching such a provider unconfigured is exactly the
        // state this surface exists to prevent. Everywhere else it opens on
        // an explicit click.
        const formOpen = wantsOrgConfig && admin
          && ((!configured && !memberPath) || configuring === entry.id);
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
              <span>{entry.title}</span>
              {wantsOrgConfig && configured && (
                <em className="tplf-chip tplf-chip--attached">org credential</em>
              )}
              {wantsOrgConfig && admin && configured && configuring !== entry.id && (
                <button
                  className="webapp-action"
                  type="button"
                  onClick={() => setConfirmingReplace(entry)}
                >Replace credential</button>
              )}
              {wantsOrgConfig && admin && !configured && memberPath
                && configuring !== entry.id && (
                <button
                  className="webapp-action"
                  type="button"
                  onClick={() => setConfiguring(entry.id)}
                >Configure org credential (optional)</button>
              )}
            </label>
            {wantsOrgConfig && admin && !configured && memberPath
              && configuring !== entry.id && (
              <p className="tplf-connection-note">
                Without an org credential, each member authorizes {entry.title}{' '}
                themselves in the workspace connections panel.
              </p>
            )}
            {wantsOrgConfig && !admin && !configured && (
              memberPath ? (
                <p className="tplf-connection-note">
                  Members connect {entry.title} themselves, inside each
                  workspace, from its connections panel. An organization
                  admin can optionally store one org credential here instead.
                </p>
              ) : (
                <p className="tplf-connection-note">
                  Ask an organization admin to configure {entry.title}:
                  its credential is stored once, right here on the
                  template page, and reaches every workspace.
                </p>
              )
            )}
            {formOpen && (
              <>
                <p className="tplf-connection-note">
                  Saving stores the credential for the whole organization
                  immediately — it does not wait for this template to be saved.
                </p>
                <ProviderAdminForm
                  entry={entry}
                  saving={savingConnection}
                  configured={configured}
                  onCancel={() => {
                    // Cancelling the only path to a usable provider also
                    // detaches it: attached-but-unconfigured is exactly the
                    // state this surface exists to prevent. A member-path
                    // provider stays attached — bare is a legitimate state
                    // for it.
                    setConfiguring(null);
                    if (!configured && !memberPath) {
                      setTemplateConnections((current) => {
                        const next = new Map(current);
                        next.delete(entry.id);
                        return next;
                      });
                    }
                  }}
                  onSubmit={(input) => { void saveOrgConnection(entry, input); }}
                />
              </>
            )}
          </div>
        );
      })}
      {confirmingReplace !== null && (
        <ConfirmationDialog
          title="Replace this organization credential?"
          description={`Replace the ${confirmingReplace.title} credential for the whole organization? Every template and workspace using it switches immediately.`}
          confirmLabel="Replace credential"
          onCancel={() => setConfirmingReplace(null)}
          onConfirm={() => {
            setConfiguring(confirmingReplace.id);
            setConfirmingReplace(null);
          }}
        />
      )}
    </div>
  );
}
