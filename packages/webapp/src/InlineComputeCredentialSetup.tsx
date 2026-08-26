import { useState } from 'react';
import type {
  ComputeCredentialMetadata,
  ComputeCredentialProvider,
  ComputeCredentialsClient,
} from './compute-credentials-api';
import {
  COMPUTE_CREDENTIAL_PROVIDER_DETAILS,
  ComputeCredentialFields,
  computeCredentialInput,
  computeCredentialProviderTitle,
  emptyComputeCredentialFields,
} from './ComputeCredentialFields';
import { caughtErrorMessage } from './error-message';
import { ProviderGlyph } from './connections/ProviderGlyph';

type SaveComputeCredential = ComputeCredentialsClient['putComputeCredential'];

function InlineProviderCredential({
  provider,
  orgId,
  saveCredential,
  onSaved,
}: {
  provider: ComputeCredentialProvider;
  orgId: string;
  saveCredential: SaveComputeCredential;
  onSaved: (metadata: ComputeCredentialMetadata) => Promise<void>;
}) {
  const details = COMPUTE_CREDENTIAL_PROVIDER_DETAILS.find(({ id }) => id === provider);
  const [fields, setFields] = useState(emptyComputeCredentialFields);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const metadata = await saveCredential(orgId, provider, computeCredentialInput(provider, fields));
      setFields(emptyComputeCredentialFields());
      await onSaved(metadata);
    } catch (caught) {
      // Validation detail crosses the API deliberately; an admin needs the
      // provider's exact refusal to repair the key.
      setError(caughtErrorMessage(caught, 'Credential validation failed.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <article className="settings-compute-card inline-compute-card">
      <div className="settings-credential-row">
        <ProviderGlyph className="settings-compute-glyph" provider={provider} />
        <div>
          <h3>Add your {computeCredentialProviderTitle(provider)} key</h3>
          <p>{details?.detail}</p>
        </div>
      </div>
      {error !== null && <p className="webapp-form-message" role="alert">{error}</p>}
      <div className="connect-form settings-compute-form">
        <ComputeCredentialFields
          provider={provider}
          value={fields}
          onChange={setFields}
          required={false}
        />
        <div className="connect-actions connect-field--wide">
          <button
            className="webapp-action webapp-action--primary"
            type="button"
            disabled={saving}
            onClick={() => { void save(); }}
          >{saving ? 'Validating…' : 'Validate and show machines'}</button>
        </div>
      </div>
    </article>
  );
}

export function InlineComputeCredentialSetup({
  providers,
  orgId,
  admin,
  saveCredential,
  onSaved,
}: {
  providers: readonly ComputeCredentialProvider[];
  orgId: string;
  admin: boolean;
  saveCredential?: SaveComputeCredential;
  onSaved: (metadata: ComputeCredentialMetadata) => Promise<void>;
}) {
  if (providers.length === 0) return null;
  if (!admin || saveCredential === undefined || orgId === '') {
    const names = providers.map(computeCredentialProviderTitle);
    return (
      <div className="blueprint-selection__empty" role="status">
        {names.join(' and ')} {names.length === 1 ? 'requires' : 'require'} an organization key.
        {' '}Ask an organization admin to add the key in Compute settings.
      </div>
    );
  }
  return (
    <div className="settings-credential-list inline-compute-list" aria-label="Cloud compute credentials required">
      {providers.map((provider) => (
        <InlineProviderCredential
          key={provider}
          provider={provider}
          orgId={orgId}
          saveCredential={saveCredential}
          onSaved={onSaved}
        />
      ))}
    </div>
  );
}
