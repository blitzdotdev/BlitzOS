/**
 * Stable type surface for the generated `dist/manifest.generated.ts`
 * (see `scripts/build-viewer.mjs`). Used as the `types` condition of the
 * `./manifest` export so typecheck never depends on the generated file existing.
 */
export const reviewViewerVersion: string;
export const reviewViewerSha256: string;
export const reviewViewerFileName: string;
