import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiRequestError, type ControlPlaneClient } from '../api';
import type {
  ComputeCredentialMetadata,
  ComputeCredentialProvider,
} from '../compute-credentials-api';
import {
  COMPUTE_CREDENTIAL_PROVIDER_DETAILS,
  ComputeCredentialFields,
  computeCredentialFieldsFromForm,
  computeCredentialInput,
} from '../ComputeCredentialFields';
import { ConfirmationDialog } from '../ConfirmationDialog';
import { caughtErrorMessage } from '../error-message';
import { KeyIcon } from '../WebAppIcons';

type ComputeClient = Pick<
  ControlPlaneClient,
  'getComputeCredential' | 'putComputeCredential' | 'deleteComputeCredential'
>;

function validatedTime(value: number) {
  const date = new Date(value);
  return {
    label: date.toLocaleString(),
    iso: date.toISOString(),
  };
}

export function ComputeCredentialsPanel({
  client,
  orgId,
}: {
  client: ComputeClient;
  orgId: string;
}) {
  const [credentials, setCredentials] = useState<Partial<
    Record<ComputeCredentialProvider, ComputeCredentialMetadata>
  >>({});
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<ComputeCredentialProvider | null>(null);
  const [saving, setSaving] = useState<ComputeCredentialProvider | null>(null);
  const [deleting, setDeleting] = useState<ComputeCredentialProvider | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ComputeCredentialProvider | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (signal?: AbortSignal) => {
    try {
      const loaded = await Promise.all(COMPUTE_CREDENTIAL_PROVIDER_DETAILS.map(async ({ id }) => {
        try {
          return await client.getComputeCredential(orgId, id, signal);
        } catch (caught) {
          if (caught instanceof ApiRequestError && caught.status === 404) return null;
          throw caught;
        }
      }));
      if (signal?.aborted) return;
      const next: Partial<Record<ComputeCredentialProvider, ComputeCredentialMetadata>> = {};
      for (const item of loaded) {
        if (item !== null) next[item.provider] = item;
      }
      setCredentials(next);
      setError(null);
    } catch (caught) {
      if (signal?.aborted) return;
      setError(caughtErrorMessage(caught, 'Compute credentials failed to load.'));
    } finally {
      if (signal?.aborted !== true) setLoading(false);
    }
  }, [client, orgId]);

  useEffect(() => {
    const abort = new AbortController();
    void reload(abort.signal);
    return () => abort.abort();
  }, [reload]);

  const save = async (
    provider: ComputeCredentialProvider,
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    if (saving !== null) return;
    setSaving(provider);
    setError(null);
    try {
      const saved = await client.putComputeCredential(
        orgId,
        provider,
        computeCredentialInput(
          provider,
          computeCredentialFieldsFromForm(new FormData(event.currentTarget)),
        ),
      );
      setCredentials((current) => ({ ...current, [provider]: saved }));
      setEditing(null);
    } catch (caught) {
      // The control plane carries the provider's validation detail. Keep it
      // verbatim so an admin can act on the actual refusal.
      setError(caughtErrorMessage(caught, 'Credential validation failed.'));
    } finally {
      setSaving(null);
    }
  };

  const remove = async (provider: ComputeCredentialProvider) => {
    if (deleting !== null) return;
    setDeleteTarget(null);
    setDeleting(provider);
    setError(null);
    try {
      await client.deleteComputeCredential(orgId, provider);
      setCredentials((current) => {
        const next = { ...current };
        delete next[provider];
        return next;
      });
      if (editing === provider) setEditing(null);
    } catch (caught) {
      setError(caughtErrorMessage(caught, 'Credential deletion failed.'));
    } finally {
      setDeleting(null);
    }
  };

  return (
    <section className="settings-panel" role="tabpanel" aria-label="Compute credentials">
      <header className="settings-panel-header">
        <div>
          <p>Organization</p>
          <h1>Compute credentials</h1>
          <span>Cloud machines are created and billed through your organization’s provider account.</span>
        </div>
      </header>
      {error && <p className="webapp-form-message" role="alert">{error}</p>}
      {loading ? (
        <p className="settings-credential-state">Loading compute credentials…</p>
      ) : (
        <div className="settings-credential-list" aria-label="Cloud compute providers">
          {COMPUTE_CREDENTIAL_PROVIDER_DETAILS.map((provider) => {
            const stored = credentials[provider.id];
            const validated = stored === undefined ? null : validatedTime(stored.validated_at);
            const open = editing === provider.id;
            return (
              <article className="settings-compute-card" key={provider.id}>
                <div className="settings-credential-row">
                  <KeyIcon className="settings-compute-glyph" />
                  <div>
                    <div className="settings-credential-row__title">
                      <h3>{provider.title}</h3>
                      <span className={stored === undefined
                        ? 'workspace-state-badge'
                        : 'workspace-state-badge workspace-state-badge--active'}>
                        {stored === undefined ? 'not set' : 'validated'}
                      </span>
                    </div>
                    <p>{provider.detail}</p>
                    {validated !== null && (
                      <time dateTime={validated.iso}>Validated {validated.label}</time>
                    )}
                  </div>
                  <div className="settings-row-actions">
                    <button
                      className="webapp-action"
                      type="button"
                      onClick={() => setEditing(open ? null : provider.id)}
                    >{open ? 'Cancel' : stored === undefined ? 'Add key' : 'Replace'}</button>
                    {stored !== undefined && (
                      <button
                        className="webapp-action webapp-action--danger"
                        type="button"
                        disabled={deleting !== null}
                        onClick={() => setDeleteTarget(provider.id)}
                      >{deleting === provider.id ? 'Deleting…' : 'Delete'}</button>
                    )}
                  </div>
                </div>
                {open && (
                  <form className="connect-form settings-compute-form" onSubmit={(event) => {
                    void save(provider.id, event);
                  }}>
                    <ComputeCredentialFields provider={provider.id} />
                    <div className="connect-actions connect-field--wide">
                      <button
                        className="webapp-action webapp-action--primary"
                        type="submit"
                        disabled={saving !== null}
                      >{saving === provider.id ? 'Validating…' : 'Validate and save'}</button>
                    </div>
                  </form>
                )}
              </article>
            );
          })}
        </div>
      )}
      {deleteTarget !== null && (
        <ConfirmationDialog
          title="Delete this compute credential?"
          description={`Delete the ${deleteTarget} credential? Existing machines keep running, but provider actions for machines created with it stop until a valid key is added again.`}
          confirmLabel="Delete credential"
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => { void remove(deleteTarget); }}
        />
      )}
    </section>
  );
}
