export const DEFAULT_CLI_API_KEY_NAME = 'Lody CLI Token';

export type CliApiKeyRecord = {
  id: string;
  name: string;
  keyStart: string | null;
  keyPreview: string | null;
  note: string | null;
  source?: 'auto' | 'manual' | 'pairing' | null;
  createdAt: number | null;
  lastRequest: number | null;
  expiresAt: number | null;
  enabled: boolean;
};

export type GenerateCliApiKeyResult =
  | {
      ok: true;
      apiKey: string;
      apiKeyId?: string;
      apiKeyStart?: string | null;
      record?: CliApiKeyRecord;
    }
  | {
      ok: false;
      error: string;
    };

export function maskCliApiKeySecret(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 12) {
    return trimmed;
  }

  const head = trimmed.slice(0, 12);
  const tail = trimmed.length > 18 ? trimmed.slice(-6) : '';
  return `${head}******${tail}`;
}
