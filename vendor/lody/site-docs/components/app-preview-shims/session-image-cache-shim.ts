// Preview shim for `@/lib/session-image-cache`.
// The real module imports session-image-upload -> the @/lib barrel -> code-collab
// `?worker` modules that the Next marketing build can't bundle. Keep this shim
// asset-backed so the landing preview can render image messages without bundling
// the app-only upload/cache stack.
const JELLYFISH_IMAGE_URL = '/landing/jellyfish.webp';

export const getSessionImageBlobUrl = async (_args?: unknown): Promise<string> =>
  JELLYFISH_IMAGE_URL;
export const getSessionImageDataUrl = async (_args?: unknown): Promise<string> =>
  JELLYFISH_IMAGE_URL;
export const clearSessionImageCache = (): void => {};
