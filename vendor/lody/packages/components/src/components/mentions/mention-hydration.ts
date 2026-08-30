import * as React from 'react';
import { useMentionContext } from '@/ui/mention';
import type { MentionKind } from '@/ui/mention/index';

export type HydratedMentions = {
  /**
   * `kind` is not optional in practice even though the range type allows it.
   * A range with no kind is indistinguishable from a bare `mention`, and both
   * the chip resolver and the before-send rewrite dispatch on it — so a
   * hydrator that omits it produces a range that renders without its icon and,
   * for sessions, silently stops expanding.
   */
  mentions: Array<{ value: string; start: number; end: number; kind: MentionKind }>;
  values: string[];
};

/**
 * Restore the mention ranges a reloaded draft's text still implies.
 *
 * Mention ranges are not persisted with a draft, so after a reload only the
 * text survives and every source has to recognise its own tokens again. The
 * guards are identical for all of them — hydrate the *initial* text only, once,
 * and never while the menu is open — as is the merge rule, which has to keep
 * existing external `pasted_text` ranges intact. Both live here so a source only
 * supplies its `hydrate`.
 *
 * `hydrate` runs after the guards pass and may return `null` when its data has
 * not arrived yet; that leaves the hydrator armed for a later attempt. Pass a
 * stable callback — it is an effect dependency.
 */
/**
 * The text a hydrator has committed to running against.
 *
 * Latches the first NON-EMPTY text rather than the first render's. A persisted
 * draft is not there on mount — `atomWithStorage` initialises with its default
 * and reads storage in `onMount` — so latching at mount latches `''`, and the
 * "only hydrate the text I measured" guard below then never passes again. That
 * is one empty string between a restored draft and every mention in it.
 */
export const latchHydrationText = (latched: string, text: string): string => latched || text;

/**
 * Whether the latched text is still the text on screen.
 *
 * Hydration computes offsets against a snapshot, so it may only apply while the
 * input still holds exactly that snapshot — otherwise the ranges land on
 * characters the user has since moved. The menu being open is the other bar: a
 * hydrate mid-completion would fight the range the menu is about to commit.
 */
export const shouldRunHydration = (latched: string, text: string, menuOpen: boolean): boolean =>
  Boolean(latched) && text === latched && !menuOpen;

/**
 * Add hydrated ranges to the ones already present, keeping what is there.
 *
 * Rejecting only exact duplicates was not enough. Hydrators run alongside each
 * other and against ranges restored from the draft, and two of them can claim
 * overlapping — not identical — regions: a path and a session slug are the same
 * shape, so `@fix-ci` can be a known file to one and a known session to
 * another, at slightly different ends. Both would survive, the renderer would
 * silently drop the later one, and the pair would then be written back to the
 * draft to be restored together next time.
 *
 * Existing ranges win, which is what makes restored-from-draft the answer and
 * text scanning the fallback: a scanner may only fill a region nothing has
 * claimed.
 */
export function mergeHydratedMentions<T extends { start: number; end: number }>(
  existing: readonly T[],
  hydrated: readonly T[]
): T[] {
  const kept = [...existing];
  const covers = (start: number, end: number) =>
    kept.some((range) => start < range.end && end > range.start);

  // Sorted so that when two hydrated ranges overlap each other, the earlier one
  // wins — the same tie-break every other range consumer applies. `covers` is
  // an unordered scan, so `kept` only needs sorting once, at the end.
  for (const mention of [...hydrated].sort((a, b) => a.start - b.start)) {
    if (covers(mention.start, mention.end)) continue;
    kept.push(mention);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/** The one trigger character that carries a mention on its own. */
const MENTION_TRIGGER = '@';

/**
 * Walk every `@<token>` span in `text`; a token runs to the next whitespace.
 *
 * The single owner of what an `@` token IS, because more than one hydrator has
 * to agree on it. Sessions and file paths are now the same shape, and the
 * session hydrator decides what it may claim by asking the file source which
 * tokens it already knows — a question with no answer if the two scanners
 * disagree about where a token ends.
 *
 * `visit` returns whether it consumed the span. An unconsumed `@` resumes the
 * search one character in rather than past the whole run, so the second half of
 * `@a@b` is still offered to the next hydrator.
 */
export function forEachAtTokenSpan(
  text: string,
  visit: (span: { token: string; start: number; end: number }) => boolean
): void {
  let index = text.indexOf(MENTION_TRIGGER);
  while (index !== -1) {
    let end = index + MENTION_TRIGGER.length;
    while (end < text.length) {
      const char = text[end];
      if (!char || char === ' ' || char === '\n' || char === '\t') break;
      end += 1;
    }
    const token = text.slice(index + MENTION_TRIGGER.length, end);
    const consumed = visit({ token, start: index, end });
    index = text.indexOf(MENTION_TRIGGER, consumed ? end : index + 1);
  }
}

/**
 * Claim every `@<slug>` token a source knows, as ranges of one kind.
 *
 * Sessions and Agent Roles hydrate identically — a bare token, a slug -> id map,
 * and the same deference to file paths — so the rule lives here once. That
 * deference is the point: a token that is also a real path is left for the file
 * hydrator, because paths are the overwhelmingly common case and mistaking one
 * for a session or a Role silently turns a file reference into a history query
 * or a Session-creation instruction, whereas the reverse only leaves a token
 * unexpanded, which the user can see.
 */
export function hydrateSlugMentionsFromText({
  text,
  slugToValue,
  kind,
  knownFileTokens,
}: {
  text: string;
  slugToValue: ReadonlyMap<string, string>;
  kind: MentionKind;
  knownFileTokens?: ReadonlySet<string>;
}): HydratedMentions {
  const mentions: HydratedMentions['mentions'] = [];
  const values = new Set<string>();
  if (slugToValue.size === 0) return { mentions, values: [] };

  forEachAtTokenSpan(text, ({ token, start, end }) => {
    if (!token || knownFileTokens?.has(token)) return false;
    const value = slugToValue.get(token);
    if (!value) return false;
    mentions.push({ value, start, end, kind });
    values.add(value);
    return true;
  });
  return { mentions, values: [...values] };
}

export function useMentionHydration(
  consumerName: string,
  {
    text,
    enabled,
    hydrate,
  }: {
    text: string;
    enabled: boolean;
    hydrate: (text: string) => HydratedMentions | null;
  }
): void {
  const context = useMentionContext(consumerName);
  const initialTextRef = React.useRef(text);
  const hydratedRef = React.useRef(false);

  React.useEffect(() => {
    if (!enabled || hydratedRef.current) return;
    initialTextRef.current = latchHydrationText(initialTextRef.current, text);
    const initialText = initialTextRef.current;
    if (!shouldRunHydration(initialText, text, context.open)) return;

    const hydrated = hydrate(initialText);
    if (!hydrated || hydrated.mentions.length === 0) return;

    hydratedRef.current = true;
    context.onMentionsChange((prev) => mergeHydratedMentions(prev, hydrated.mentions));
    context.onValueChange((prev) => Array.from(new Set([...(prev ?? []), ...hydrated.values])));
  }, [context, enabled, hydrate, text]);
}
