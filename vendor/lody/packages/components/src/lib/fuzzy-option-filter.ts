import { fuzzyMatch } from '@/components/commands/fuzzy-match';

/**
 * Fuzzy filtering for option lists (composer model pickers, provider-defined
 * selects). An agent provider can publish a hundred models, and a list that
 * long is only usable if the user can type at it.
 *
 * Matching is the command palette's subsequence scorer (`fuzzyMatch`) applied
 * per whitespace-separated term, so a query reads as "all of these, in any
 * order": `opus 5` finds `claude-opus-5` even though the query's space is not
 * in the text, and `sonnet think` finds `Sonnet (thinking)`.
 *
 * `components/shared/option-selector.tsx` still ranks with its own single-term
 * `fuzzyMatch` loop; migrating it here is worth doing, and would make `op5`
 * work in the branch/project pickers too.
 */

/**
 * Below this many options a list is short enough to read at a glance, and a
 * search field costs more attention than it saves. The composer's run-config
 * surfaces (desktop menu + mobile sheet) share it so they cannot drift; older
 * pickers still spell the same threshold inline as `length > 5` and should be
 * converted as they are touched.
 */
export const OPTION_SEARCH_MIN_OPTIONS = 6;

export const shouldOfferOptionSearch = (optionCount: number): boolean =>
  optionCount >= OPTION_SEARCH_MIN_OPTIONS;

/**
 * Text a query is matched against. `primary` is what the row displays;
 * `secondary` is everything else worth finding by (the model id behind a
 * pretty label, a description) and always ranks below a primary match, so
 * typing a visible name never buries it under rows that merely mention it.
 */
export type FuzzyOptionText = {
  primary: string;
  secondary?: ReadonlyArray<string | null | undefined>;
};

const scoreText = (terms: readonly string[], text: string): number | null => {
  let total = 0;
  for (const term of terms) {
    const score = fuzzyMatch(term, text);
    if (score === null) return null;
    total += score;
  }
  return total;
};

/**
 * `items` filtered to those matching `query`, best match first. An empty query
 * returns the list itself — the provider's own order is meaningful (default
 * model first), so it is only re-ranked once the user asks for something.
 * Equal scores keep that original order.
 */
export function filterFuzzyOptions<T>(
  items: readonly T[],
  query: string,
  getText: (item: T) => FuzzyOptionText
): readonly T[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return items;

  /* Two tiers rather than one score with a penalty: "matched what the row
     shows" and "matched something behind it" are different answers, and a
     number wide enough to keep them apart is a constant nobody can check. The
     tiers also make the secondary texts skippable — once the primary matched,
     nothing found behind the row could outrank it. */
  const ranked: Array<{ item: T; index: number; tier: 0 | 1; score: number }> = [];
  items.forEach((item, index) => {
    const { primary, secondary } = getText(item);
    const primaryScore = scoreText(terms, primary);
    if (primaryScore !== null) {
      ranked.push({ item, index, tier: 0, score: primaryScore });
      return;
    }
    let best: number | null = null;
    for (const text of secondary ?? []) {
      // A secondary equal to the primary is the common case (an option whose id
      // IS its label), and scoring it again can only reach the same verdict.
      if (!text || text === primary) continue;
      const score = scoreText(terms, text);
      if (score !== null && (best === null || score > best)) best = score;
    }
    if (best !== null) ranked.push({ item, index, tier: 1, score: best });
  });

  ranked.sort((a, b) => a.tier - b.tier || b.score - a.score || a.index - b.index);
  return ranked.map((entry) => entry.item);
}
