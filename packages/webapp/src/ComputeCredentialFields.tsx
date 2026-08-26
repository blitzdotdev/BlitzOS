import type { ComputeCredentialInput, ComputeCredentialProvider } from './compute-credentials-api';

export const COMPUTE_CREDENTIAL_PROVIDER_DETAILS: readonly {
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

export interface ComputeCredentialFieldsValue {
  token: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

export function emptyComputeCredentialFields(): ComputeCredentialFieldsValue {
  return { token: '', accessKeyId: '', secretAccessKey: '', sessionToken: '' };
}

export function computeCredentialInput(
  provider: ComputeCredentialProvider,
  fields: ComputeCredentialFieldsValue,
): ComputeCredentialInput {
  if (provider === 'hetzner') return { token: fields.token };
  return fields.sessionToken === ''
    ? { accessKeyId: fields.accessKeyId, secretAccessKey: fields.secretAccessKey }
    : {
        accessKeyId: fields.accessKeyId,
        secretAccessKey: fields.secretAccessKey,
        sessionToken: fields.sessionToken,
      };
}

export function computeCredentialFieldsFromForm(data: FormData): ComputeCredentialFieldsValue {
  return {
    token: data.get('token')?.toString() ?? '',
    accessKeyId: data.get('accessKeyId')?.toString() ?? '',
    secretAccessKey: data.get('secretAccessKey')?.toString() ?? '',
    sessionToken: data.get('sessionToken')?.toString() ?? '',
  };
}

export function isComputeCredentialProvider(value: string): value is ComputeCredentialProvider {
  return value === 'hetzner' || value === 'aws';
}

export function computeCredentialProviderTitle(provider: ComputeCredentialProvider): string {
  return COMPUTE_CREDENTIAL_PROVIDER_DETAILS.find(({ id }) => id === provider)?.title ?? provider;
}

export function ComputeCredentialFields({
  provider,
  value,
  onChange,
  required = true,
}: {
  provider: ComputeCredentialProvider;
  value?: ComputeCredentialFieldsValue;
  onChange?: (value: ComputeCredentialFieldsValue) => void;
  required?: boolean;
}) {
  const update = (
    field: keyof ComputeCredentialFieldsValue,
    next: string,
  ) => {
    if (value === undefined || onChange === undefined) return;
    onChange({ ...value, [field]: next });
  };
  if (provider === 'hetzner') {
    return (
      <label className="connect-field connect-field--wide">
        <span className="connect-field__label">API token</span>
        <input
          name="token"
          type="password"
          required={required}
          autoComplete="new-password"
          value={value?.token}
          onChange={(event) => update('token', event.currentTarget.value)}
        />
      </label>
    );
  }
  return (
    <>
      <label className="connect-field">
        <span className="connect-field__label">Access key ID</span>
        <input
          name="accessKeyId"
          required={required}
          autoComplete="off"
          value={value?.accessKeyId}
          onChange={(event) => update('accessKeyId', event.currentTarget.value)}
        />
      </label>
      <label className="connect-field">
        <span className="connect-field__label">Secret access key</span>
        <input
          name="secretAccessKey"
          type="password"
          required={required}
          autoComplete="new-password"
          value={value?.secretAccessKey}
          onChange={(event) => update('secretAccessKey', event.currentTarget.value)}
        />
      </label>
      <label className="connect-field connect-field--wide">
        <span className="connect-field__label">Session token (optional)</span>
        <input
          name="sessionToken"
          type="password"
          autoComplete="new-password"
          value={value?.sessionToken}
          onChange={(event) => update('sessionToken', event.currentTarget.value)}
        />
      </label>
    </>
  );
}
