import type { UrlTransform } from 'react-markdown'

const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])
const SAFE_IMAGE_PROTOCOLS = new Set(['http:', 'https:'])
export const DATA_IMAGE_RE = /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=]+$/i

export function normalizedExternalUrl(raw?: string): string | null {
  const value = String(raw || '').trim()
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null
  try {
    const url = new URL(value)
    return SAFE_LINK_PROTOCOLS.has(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

export function normalizedImageSrc(raw?: string): string | null {
  const value = String(raw || '').trim()
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null
  if (DATA_IMAGE_RE.test(value)) return value
  try {
    const url = new URL(value)
    return SAFE_IMAGE_PROTOCOLS.has(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

export const markdownUrlTransform: UrlTransform = (value, key) => {
  if (key === 'src') return normalizedImageSrc(value) || ''
  return normalizedExternalUrl(value) || ''
}
