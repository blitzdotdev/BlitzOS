import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiRequestError, type ControlPlaneClient } from '../api';
import type {
  ComputeCredentialInput,
  ComputeCredentialMetadata,
  ComputeCredentialProvider,
} from '../compute-credentials-api';
import { ConfirmationDialog } from '../ConfirmationDialog';
import { caughtErrorMessage } from '../error-message';
import { ProviderGlyph } from '../connections/ProviderGlyph';

type ComputeClient = Pick<
  ControlPlaneClient,
  'getComputeCredential' | 'putComputeCredential' | 'deleteComputeCredential'
>;

const PROVIDERS: readonly {
  id: ComputeCredentialProvider;
  title: string;
  detail: string;
}[] = [
  {
    id: 'hetzner',
    title: 'Hetzner Cloud',
    detail: 'A project API token with read and write access.',
  },
  {
    id: 'aws',
    title: 'Amazon Web Services',
    detail: 'An access key allowed to manage this deployment’s EC2 resources.',
  },
];

function field(data: FormData, name: string): string {
  return data.get(name)?.toString() ?? '';
}

function credentialInput(
  provider: ComputeCredentialProvider,
  data: FormData,
): ComputeCredentialInput {
  if (provider === 'hetzner') return { token: field(data, 'token') };
  const accessKeyId = field(data, 'accessKeyId');
  const secretAccessKey = field(data, 'secretAccessKey');
  const sessionToken = field(data, 'sessionToken');
  return sessionToken === ''
    ? { accessKeyId, secretAccessKey }
    : { accessKeyId, secretAccessKey, sessionToken };
}

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
      const loaded = await Promise.all(PROVIDERS.map(async ({ id }) => {
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
        credentialInput(provider, new FormData(event.currentTarget)),
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
          {PROVIDERS.map((provider) => {
            const stored = credentials[provider.id];
            const validated = stored === undefined ? null : validatedTime(stored.validated_at);
            const open = editing === provider.id;
            return (
              <article className="settings-compute-card" key={provider.id}>
                <div className="settings-credential-row">
                  <ProviderGlyph className="settings-compute-glyph" provider={provider.id} />
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
                    {provider.id === 'hetzner' ? (
                      <label className="connect-field connect-field--wide">
                        <span className="connect-field__label">API token</span>
                        <input name="token" type="password" required autoComplete="new-password" />
                      </label>
                    ) : (
                      <>
                        <label className="connect-field">
                          <span className="connect-field__label">Access key ID</span>
                          <input name="accessKeyId" required autoComplete="off" />
                        </label>
                        <label className="connect-field">
                          <span className="connect-field__label">Secret access key</span>
                          <input name="secretAccessKey" type="password" required autoComplete="new-password" />
                        </label>
                        <label className="connect-field connect-field--wide">
                          <span className="connect-field__label">Session token (optional)</span>
                          <input name="sessionToken" type="password" autoComplete="new-password" />
                        </label>
                      </>
                    )}
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
