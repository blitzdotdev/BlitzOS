import * as React from 'react';
import { useTranslation } from 'react-i18next';

import { sanitizeMessageTextSpans, type MessageTextSpan } from '@lody/shared';
import { cn } from '@/lib/utils';
import {
  getMentionKindIcon,
  MENTION_CHIP_CLASS_NAME,
  MENTION_NEUTRAL_CHIP_CLASS_NAME,
} from '@/components/mentions/mention-chips';

/**
 * Mention chips inside a sent message.
 *
 * The composer's chips are painted over a live textarea and may not change the
 * advance width of a single character. These are not: a transcript bubble is
 * static text, so a chip here is an ordinary `inline-flex` element with real
 * padding and a real gap. Only the layout is local — the glyph and the colour
 * come from `mention-chips.tsx`, which is what makes `@src/a.ts` look like the
 * same object before and after it is sent.
 *
 * The text these span is the *rewritten* text the agent received. A skill
 * mention is sitting in there as `use /x [Skill Path](...)`, a pasted blob as
 * its full four thousand characters. The chip covers that region and shows the
 * span's `label` — what the user actually typed — instead.
 */

/**
 * No background here either, matching the composer: a mention is coloured text
 * with an icon. Horizontal padding goes with it — without a fill there is
 * nothing to pad, and the `gap` alone separates icon from label.
 *
 * The line-height is the load-bearing part. `truncate` on the label means
 * `overflow: hidden`, so the label's box has to be tall enough to contain its
 * own glyphs — at `leading-none` it is exactly one font-size tall, about a
 * pixel short of what a descender or a CJK glyph needs, and the bottom of
 * `$imagegen` or 会话 gets shaved off.
 *
 * It also may not be so tall that it grows the line box, which would break the
 * collapsed-message height (a whole number of line boxes) into a half-clipped
 * row. `1.15` clears the glyphs and still sits under the smallest line-height
 * ratio any conversation font size uses, so it scales with all three.
 *
 * `align-middle` rather than `align-baseline` for the same reason: a
 * baseline-aligned flex box sits entirely above the baseline and pushes the
 * line taller.
 */
const CHIP_CLASS_NAME = 'inline-flex max-w-full items-center gap-1 align-middle leading-[1.15]';

function MessageTextChip({
  span,
  label,
  onToggle,
}: {
  span: MessageTextSpan;
  /** Resolved by the parent so a chip costs no i18n subscription of its own. */
  label: string;
  /** Only pasted text has an action: it expands in place. */
  onToggle?: () => void;
}) {
  const className = cn(
    CHIP_CLASS_NAME,
    span.kind === 'pasted_text' ? MENTION_NEUTRAL_CHIP_CLASS_NAME : MENTION_CHIP_CLASS_NAME,
    // With no fill to darken, the hover affordance has to be typographic.
    onToggle && 'cursor-pointer hover:underline'
  );
  const content = (
    <>
      {/* A frozen mark (an Agent Role's emoji) stands in for the kind's icon, so
          the bubble shows the same thing the composer did. */}
      {span.mark ? (
        <span aria-hidden="true" className="text-[1.05em] leading-none">
          {span.mark}
        </span>
      ) : (
        getMentionKindIcon(span.kind, { path: span.target })
      )}
      <span className="truncate">{label}</span>
    </>
  );

  return onToggle ? (
    <button type="button" className={className} onClick={onToggle}>
      {content}
    </button>
  ) : (
    <span className={className}>{content}</span>
  );
}

/**
 * Splits `text` on its spans and renders each span as a chip.
 *
 * Spans are re-sanitized against the exact string being rendered rather than
 * trusted from the caller, because that string may be a truncated slice — a
 * chip straddling the cut has nothing coherent to render and is dropped until
 * the bubble is expanded.
 */
export function MessageTextWithChips({
  text,
  spans,
}: {
  text: string;
  spans: readonly MessageTextSpan[] | undefined;
}) {
  const { t } = useTranslation();
  const resolved = React.useMemo(() => sanitizeMessageTextSpans(text, spans), [spans, text]);
  const [expanded, setExpanded] = React.useState<ReadonlySet<number>>(() => new Set());

  if (!resolved) return <>{text}</>;

  const nodes: React.ReactNode[] = [];
  let copiedTo = 0;

  for (const span of resolved) {
    if (span.start > copiedTo) {
      nodes.push(
        <React.Fragment key={`t-${copiedTo}`}>{text.slice(copiedTo, span.start)}</React.Fragment>
      );
    }

    const isExpanded = span.kind === 'pasted_text' && expanded.has(span.start);
    const start = span.start;
    nodes.push(
      <React.Fragment key={`s-${start}`}>
        <MessageTextChip
          span={span}
          label={
            isExpanded
              ? t('sessions.messageChip.collapsePastedText', 'Collapse pasted text')
              : span.label
          }
          onToggle={
            span.kind === 'pasted_text'
              ? () =>
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    if (next.has(start)) next.delete(start);
                    else next.add(start);
                    return next;
                  })
              : undefined
          }
        />
        {isExpanded ? text.slice(span.start, span.end) : null}
      </React.Fragment>
    );

    copiedTo = span.end;
  }

  if (copiedTo < text.length) {
    nodes.push(<React.Fragment key="t-end">{text.slice(copiedTo)}</React.Fragment>);
  }

  return <>{nodes}</>;
}
