import {
  asJsonObject,
  isNumber,
  isString,
  type JsonValue,
} from './type-guards';

export type ComputeCredentialProvider = 'hetzner' | 'aws';

export interface ComputeCredentialMetadata {
  provider: ComputeCredentialProvider;
  validated_at: number;
  created_by: string;
}

export interface HetznerComputeCredentialInput {
  token: string;
}

export interface AwsComputeCredentialInput {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export type ComputeCredentialInput =
  | HetznerComputeCredentialInput
  | AwsComputeCredentialInput;

export interface ComputeCredentialsClient {
  getComputeCredential(
    orgId: string,
    provider: ComputeCredentialProvider,
    signal?: AbortSignal,
  ): Promise<ComputeCredentialMetadata>;
  putComputeCredential(
    orgId: string,
    provider: ComputeCredentialProvider,
    input: ComputeCredentialInput,
  ): Promise<ComputeCredentialMetadata>;
  deleteComputeCredential(
    orgId: string,
    provider: ComputeCredentialProvider,
  ): Promise<void>;
}

export interface WebAppApiRequest {
  <T>(
    path: string,
    init?: RequestInit,
    decode?: (json: string) => T,
  ): Promise<T>;
}

function decodeComputeCredentialMetadata(json: string): ComputeCredentialMetadata {
  let value: JsonValue;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error('compute credential returned invalid JSON');
  }
  const object = asJsonObject(value);
  if (
    object === null
    || (object.provider !== 'hetzner' && object.provider !== 'aws')
    || !isNumber(object.validated_at)
    || !Number.isSafeInteger(object.validated_at)
    || !isString(object.created_by)
  ) {
    throw new Error('compute credential returned invalid metadata');
  }
  return {
    provider: object.provider,
    validated_at: object.validated_at,
    created_by: object.created_by,
  };
}

function credentialPath(orgId: string, provider: ComputeCredentialProvider): string {
  return `/orgs/${encodeURIComponent(orgId)}/compute-credentials/${provider}`;
}

export function createComputeCredentialsClient(
  request: WebAppApiRequest,
): ComputeCredentialsClient {
  return {
    getComputeCredential: (orgId, provider, signal) =>
      request<ComputeCredentialMetadata>(
        credentialPath(orgId, provider),
        { signal },
        decodeComputeCredentialMetadata,
      ),
    putComputeCredential: (orgId, provider, input) =>
      request<ComputeCredentialMetadata>(
        credentialPath(orgId, provider),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        },
        decodeComputeCredentialMetadata,
      ),
    deleteComputeCredential: (orgId, provider) =>
      request<void>(credentialPath(orgId, provider), { method: 'DELETE' }),
  };
}
