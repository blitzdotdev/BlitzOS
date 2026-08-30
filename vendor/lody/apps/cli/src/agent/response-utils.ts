const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const getStringField = (obj: Record<string, unknown>, key: string): string | null => {
  const value = obj[key];
  return typeof value === 'string' ? value : null;
};

/**
 * Best-effort extraction of a textual response from ACP prompt results.
 * Returns the first non-empty string found in common fields.
 */
export const extractTextFromAgentResponse = (response: unknown): string | null => {
  if (!response) return null;
  if (typeof response === 'string') return response;

  if (!isRecord(response)) {
    return null;
  }

  const nested = response['response'];
  const nestedRecord = isRecord(nested) ? nested : null;

  const directText =
    getStringField(response, 'text') ??
    getStringField(response, 'title') ??
    getStringField(response, 'output') ??
    (nestedRecord
      ? (getStringField(nestedRecord, 'text') ??
        getStringField(nestedRecord, 'title') ??
        getStringField(nestedRecord, 'output'))
      : null);
  if (directText) {
    return directText;
  }

  const containerValue = response['content'] ?? response['responses'] ?? response['choices'];
  if (Array.isArray(containerValue)) {
    for (const item of containerValue) {
      const candidate = extractTextFromAgentResponse(item);
      if (candidate) return candidate;
    }
  }

  return null;
};
