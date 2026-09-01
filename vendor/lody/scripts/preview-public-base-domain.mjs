export const PREVIEW_PUBLIC_BASE_DOMAIN_ENV = 'VITE_PREVIEW_PUBLIC_BASE_DOMAIN';
export const PREVIEW_PUBLIC_BASE_DOMAIN_PLACEHOLDER = '__LODY_PREVIEW_PUBLIC_BASE_DOMAIN__';

const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizePreviewPublicBaseDomain(value) {
  const domain = value?.trim().toLowerCase() ?? '';
  const labels = domain.split('.');
  const hasValidLabels =
    domain.length <= 253 &&
    labels.length >= 2 &&
    labels.every((label) => DNS_LABEL_PATTERN.test(label)) &&
    !/^\d+$/.test(labels.at(-1) ?? '');

  if (!hasValidLabels) {
    throw new Error(
      `${PREVIEW_PUBLIC_BASE_DOMAIN_ENV} must be an ASCII public base domain without a scheme, wildcard, port, path, query, or trailing dot (for example, lody.uk)`
    );
  }

  return domain;
}

export function requirePreviewPublicBaseDomain(env, context) {
  const rawValue = env[PREVIEW_PUBLIC_BASE_DOMAIN_ENV];
  if (!rawValue?.trim()) {
    throw new Error(`${context}: missing required ${PREVIEW_PUBLIC_BASE_DOMAIN_ENV}`);
  }

  try {
    return normalizePreviewPublicBaseDomain(rawValue);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${context}: ${message}`, { cause: error });
  }
}

export function previewPublicWildcardSource(baseDomain) {
  return `https://*.${normalizePreviewPublicBaseDomain(baseDomain)}`;
}

export function injectPreviewPublicBaseDomain(content, baseDomain) {
  return content.replaceAll(
    PREVIEW_PUBLIC_BASE_DOMAIN_PLACEHOLDER,
    normalizePreviewPublicBaseDomain(baseDomain)
  );
}
