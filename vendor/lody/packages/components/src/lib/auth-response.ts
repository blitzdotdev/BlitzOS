export type AuthResponseError = {
  message?: string;
  status?: number;
  code?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function numberFromUnknown(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function getAuthResponseError(response: unknown): AuthResponseError | null {
  if (!isRecord(response) || !('error' in response) || response.error == null) {
    return null;
  }

  const error = response.error;
  if (typeof error === 'string') {
    return { message: error };
  }
  if (!isRecord(error)) {
    if (typeof error === 'number' || typeof error === 'boolean' || typeof error === 'bigint') {
      return { message: error.toString() };
    }
    if (typeof error === 'symbol') {
      return { message: error.description ?? 'Authentication failed' };
    }
    return { message: 'Authentication failed' };
  }

  const status = numberFromUnknown(error.status) ?? numberFromUnknown(error.statusCode);
  return {
    message: typeof error.message === 'string' ? error.message : undefined,
    status,
    code: typeof error.code === 'string' ? error.code : undefined,
  };
}
