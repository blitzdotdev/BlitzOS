import { normalizePreviewPublicBaseDomain } from '@lody/shared';

const configuredDomain = import.meta.env.VITE_PREVIEW_PUBLIC_BASE_DOMAIN;

if (!configuredDomain) {
  throw new Error('Missing required VITE_PREVIEW_PUBLIC_BASE_DOMAIN');
}

export const previewPublicBaseDomain = normalizePreviewPublicBaseDomain(configuredDomain);
