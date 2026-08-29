/**
 * Injects a review bundle/snapshot into the prebuilt standalone HTML template.
 *
 * The template (built by `vite.standalone.config.ts`, shipped at
 * `dist-standalone/index.html`) contains the inlined viewer JS/CSS but no review
 * data. Consumers (the package CLI and `lody review`) call `injectReviewSnapshot`
 * to produce the final self-contained `.review.html` for a specific review.
 *
 * This is a pure string transform so it works in any runtime without bundler help.
 */
import type { ReviewBundleInput } from '../snapshot';

export const REVIEW_GLOBAL_NAME = '__LODY_REVIEW__';

const PLACEHOLDER = '<!--LODY_REVIEW_DATA-->';

/**
 * Serializes `data` to a `<script>` that assigns `window.__LODY_REVIEW__` and
 * splices it into `template` ahead of the inlined module script.
 *
 * The JSON is `<`-escaped so it can never break out of the `<script>` element
 * (e.g. a literal `</script>` inside review text) or open an HTML comment.
 *
 * The splice uses a *function* replacement (`() => script`) rather than a string
 * replacement on purpose: `String.prototype.replace` interprets `$` patterns
 * (`$&`, `` $` ``, `$'`, `$$`, `$n`) in a string replacement. Review data inlines
 * the full source of every reviewed file, and code is full of `$` (`${...}`
 * template literals, regex `$&`/`$1`, shell `$'...'`). With a string replacement
 * those sequences expand — e.g. `$'` splices the entire template tail into the
 * middle of the `<script>` JSON — producing a syntactically broken script that
 * never assigns `window.__LODY_REVIEW__`, so the viewer renders "No review data
 * was embedded". A function replacement returns the text verbatim, no `$` magic.
 */
export function injectReviewSnapshot(template: string, data: ReviewBundleInput): string {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const script = `<script>window.${REVIEW_GLOBAL_NAME}=${json}</script>`;

  if (template.includes(PLACEHOLDER)) {
    return template.replace(PLACEHOLDER, () => script);
  }
  if (template.includes('</head>')) {
    return template.replace('</head>', () => `${script}</head>`);
  }
  // Fall back to prepending so the global is defined before any module runs.
  return `${script}${template}`;
}
