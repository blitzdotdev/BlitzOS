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
import { ProviderGlyph } from '../connections/ProviderGlyph';

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
      <p>Apps this template needs. Members sign in to each one inside their workspace.</p>
      {connectionError && (
        <p className="webapp-form-message" role="alert">{connectionError}</p>
      )}
      {catalog.map((entry) => {
        const chosen = templateConnections.get(entry.id) ?? null;
        const configured = orgCredentialFor(orgConnections, entry.id);
        const wantsOrgConfig = chosen !== null && entry.adminForm !== null;
        // A provider with no admin form has no org-key path at all, so every
        // branch below — which all hang off wantsOrgConfig — used to skip it.
        // Selecting Google Workspace, Linear or YouTrack therefore produced a
        // bare checkbox that explained nothing. They are member-authorized, so
        // say that, in the sentence the org-key providers already use.
        const memberOnly = chosen !== null && entry.adminForm === null;
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
              <ProviderGlyph className="tplf-connection-glyph" provider={entry.id} />
              <span>{entry.title}</span>
              {wantsOrgConfig && configured && (
                <em className="tplf-chip tplf-chip--attached">org key</em>
              )}
              {wantsOrgConfig && admin && configured && configuring !== entry.id && (
                <button
                  className="webapp-action tplf-connection-action"
                  type="button"
                  onClick={() => setConfirmingReplace(entry)}
                >Replace {entry.title} key</button>
              )}
              {wantsOrgConfig && admin && !configured && memberPath
                && configuring !== entry.id && (
                <button
                  className="webapp-action tplf-connection-action"
                  type="button"
                  onClick={() => setConfiguring(entry.id)}
                >Add {entry.title} key</button>
              )}
            </label>
            {wantsOrgConfig && admin && !configured && memberPath
              && configuring !== entry.id && (
              <p className="tplf-connection-note">
                Without an org key, members sign in to {entry.title} themselves.
              </p>
            )}
            {memberOnly && (
              <p className="tplf-connection-note">
                Members sign in to {entry.title} themselves.
              </p>
            )}
            {wantsOrgConfig && !admin && !configured && (
              memberPath ? (
                <p className="tplf-connection-note">
                  Members sign in to {entry.title} themselves.
                </p>
              ) : (
                <p className="tplf-connection-note">
                  Ask an admin to add the {entry.title} key.
                </p>
              )
            )}
            {formOpen && (
              <>
                <p className="tplf-connection-note">
                  Saving applies to the whole org right away.
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
          title={`Replace the ${confirmingReplace.title} key?`}
          description="Every template and workspace at this organization switches to the new key immediately."
          confirmLabel="Replace key"
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
