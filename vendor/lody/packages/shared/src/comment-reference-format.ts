import type { CommentReferencePayload, VisualAnnotationReferencePayload } from './ai';

const escapeAttribute = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Format a comment reference as structured text for the AI prompt.
 *
 * Output format:
 * ```
 * <comment-reference path="src/foo.ts" line="42" side="additions">
 * @alice:
 * Comment body here...
 *
 * > @bob:
 * > Reply body here...
 * </comment-reference>
 * ```
 */
export function formatCommentReferenceForPrompt(ref: CommentReferencePayload): string {
  const lines: string[] = [];
  lines.push(`<comment-reference path="${ref.path}" line="${ref.lineNumber}" side="${ref.side}">`);
  lines.push(`@${ref.authorName}:`);
  lines.push(ref.commentBody);

  if (ref.replies && ref.replies.length > 0) {
    lines.push('');
    for (const reply of ref.replies) {
      lines.push(`> @${reply.authorName}:`);
      lines.push(
        reply.body
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n')
      );
    }
  }

  lines.push('</comment-reference>');
  return lines.join('\n');
}

export function formatVisualAnnotationReferenceForPrompt(
  ref: VisualAnnotationReferencePayload
): string {
  const target = ref.anchor.target;
  const page = ref.anchor.page;
  const click = ref.anchor.click;
  const author = ref.authorName ?? 'Reviewer';
  const lines: string[] = [];
  lines.push(
    `<visual-annotation-reference url="${escapeAttribute(page.url)}" pathname="${escapeAttribute(
      page.pathname
    )}" selector="${escapeAttribute(target.selector)}" tag="${escapeAttribute(
      target.tag
    )}" viewport-x-ratio="${click.viewportXRatio}" viewport-y-ratio="${click.viewportYRatio}">`
  );
  lines.push(`@${author}:`);
  lines.push(ref.body);

  if (target.text) {
    lines.push('');
    lines.push(`Target text: ${target.text}`);
  }

  if (ref.anchor.context.nearbyText && ref.anchor.context.nearbyText.length > 0) {
    lines.push('');
    lines.push('Nearby text:');
    for (const text of ref.anchor.context.nearbyText.slice(0, 3)) {
      lines.push(`- ${text}`);
    }
  }

  lines.push('</visual-annotation-reference>');
  return lines.join('\n');
}

/**
 * Truncate a comment body for preview display (composer chips, bubble cards).
 */
export function truncateCommentBody(body: string, maxLength: number = 50): string {
  const firstLine = body.split('\n')[0] ?? body;
  if (firstLine.length <= maxLength) return firstLine;
  return firstLine.slice(0, maxLength - 1) + '\u2026';
}
