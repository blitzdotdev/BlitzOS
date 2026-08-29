/**
 * Image extension/MIME detection. The canonical map now lives in `@lody/shared`
 * (`image-file-types.ts`) so the Node CLI and the web UI agree on exactly which
 * extensions are previewable images; this module re-exports it for existing web
 * callers that import from `@/lib/image-file-preview`.
 */
export {
  getImageMimeTypeForPath,
  isPreviewableImagePath,
  isSvgPath,
  isBinaryImagePath,
} from '@lody/shared';
