/** The deep-link rule for a persisted preview tab.
 *
 * A preview tab renders an iframe at `/preview/<port><path>`. The browser
 * normalizes that URL before the request leaves the tab, so a stored `..`
 * segment walks the iframe out of the `/preview/<port>/` prefix and onto
 * another box surface — the proxy's own traversal check never sees a `..`,
 * because normalization already removed it. Every reader of a path therefore
 * repeats this rule: the Go gateway, the browser, and this parser.
 *
 * This is a copy of `@blitzos/schema`'s `preview`, kept because core stays
 * portable and imports nothing outside itself (see `test/core-imports.test.ts`).
 * The two are pinned together by `test/preview-drift.test.ts`, the same way
 * `webapp-surface.ts` mirrors its schema module. */

export const MAX_PREVIEW_PATH_LENGTH = 4_096;

export function isPreviewPath(path: string): boolean {
  return path.startsWith("/")
    && path.length <= MAX_PREVIEW_PATH_LENGTH
    && !path.split("/").includes("..");
}
