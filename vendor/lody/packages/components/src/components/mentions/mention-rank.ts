/**
 * The one ranking rule every `@` category shares.
 *
 * A prefix match outranks a substring one, and nothing else matches — the menu
 * is a completion surface, not a search engine, and a category that scored
 * differently would make the same typing behave differently depending on which
 * kind of thing the user was reaching for. Sources differ only in which of
 * their fields are matched and how they break a tie.
 *
 * A leaf module on purpose: the registry imports the sources, so the sources
 * cannot import the registry.
 */
export function rankMentionCandidates<T>(
  items: readonly T[],
  term: string,
  options: {
    /** Every row is an arrow-key stop, so a source must never return more. */
    limit: number;
    fields: (item: T) => readonly string[];
    /** Applied between equally-scored items; source order otherwise. */
    tieBreak?: (left: T, right: T) => number;
  }
): T[] {
  const query = term.trim().toLowerCase();
  if (!query) return items.slice(0, options.limit);
  const { tieBreak } = options;
  return items
    .map((item) => {
      let score = -1;
      for (const field of options.fields(item)) {
        const value = field.toLowerCase();
        if (value.startsWith(query)) {
          score = 0;
          break;
        }
        if (value.includes(query)) score = 1;
      }
      return { item, score };
    })
    .filter((entry) => entry.score >= 0)
    .sort((left, right) =>
      left.score !== right.score
        ? left.score - right.score
        : tieBreak
          ? tieBreak(left.item, right.item)
          : 0
    )
    .slice(0, options.limit)
    .map((entry) => entry.item);
}
