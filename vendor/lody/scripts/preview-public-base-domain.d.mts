export const PREVIEW_PUBLIC_BASE_DOMAIN_ENV: 'VITE_PREVIEW_PUBLIC_BASE_DOMAIN';
export const PREVIEW_PUBLIC_BASE_DOMAIN_PLACEHOLDER: '__LODY_PREVIEW_PUBLIC_BASE_DOMAIN__';

export function normalizePreviewPublicBaseDomain(value: string | undefined): string;

export function requirePreviewPublicBaseDomain(
  env: Record<string, string | undefined>,
  context: string
): string;

export function previewPublicWildcardSource(baseDomain: string): string;

export function injectPreviewPublicBaseDomain(content: string, baseDomain: string): string;
