/**
 * Single source of truth for "which file extensions are previewable images and
 * what MIME type do they map to". Lives in `@lody/shared` so it can be used both
 * by the Node CLI (deciding whether to read a file as raw bytes) and by the web
 * UI (rendering the bytes via an object URL). The web layer re-exports these
 * from `packages/components/src/lib/image-file-preview.ts`.
 *
 * The list is intentionally limited to formats that browsers (incl. iOS
 * WKWebView and Android WebView, our mobile targets) can actually render with a
 * plain `<img>`. Formats that only some engines support (HEIC/HEIF, TIFF) are
 * deliberately excluded so we never show a broken image on a platform that
 * cannot decode it.
 */
const IMAGE_MIME_TYPE_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  apng: 'image/apng',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  cur: 'image/x-icon',
  avif: 'image/avif',
};

/**
 * Returns the image MIME type for a file path/name based on its extension, or
 * undefined when the extension is not a previewable raster/vector image.
 */
export function getImageMimeTypeForPath(pathOrName: string): string | undefined {
  const lastDot = pathOrName.lastIndexOf('.');
  if (lastDot < 0 || lastDot === pathOrName.length - 1) return undefined;
  const extension = pathOrName
    .slice(lastDot + 1)
    .trim()
    .toLowerCase();
  return IMAGE_MIME_TYPE_BY_EXTENSION[extension];
}

/** True when the path looks like an image we can preview. */
export function isPreviewableImagePath(pathOrName: string): boolean {
  return getImageMimeTypeForPath(pathOrName) !== undefined;
}

/**
 * SVG is XML text, so it is read/transferred as a text file rather than a binary
 * blob. It can be shown both as source (code) and rendered, so callers treat it
 * specially (render from `svgText`) instead of the raw-bytes image path.
 */
export function isSvgPath(pathOrName: string): boolean {
  return getImageMimeTypeForPath(pathOrName) === 'image/svg+xml';
}

/**
 * True for image files that are transferred as raw bytes (everything except
 * SVG, which stays text). The CLI uses this to decide when to base64-encode a
 * local file read instead of decoding it as UTF-8.
 */
export function isBinaryImagePath(pathOrName: string): boolean {
  const mimeType = getImageMimeTypeForPath(pathOrName);
  return mimeType !== undefined && mimeType !== 'image/svg+xml';
}
