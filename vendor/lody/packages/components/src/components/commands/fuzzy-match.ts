/**
 * Lightweight fuzzy subsequence matcher for the command palette. Returns a score
 * (higher = better) when every character of `query` appears in `text` in order, or
 * `null` when it doesn't match at all. Case-insensitive.
 *
 * Tuned for short strings (command titles, session titles) — not large documents.
 * We deliberately avoid pulling in fuse.js here: the palette is mounted in the always-on
 * app shell, and a hand-rolled subsequence scorer keeps it out of the main bundle while
 * giving the "type a few letters, jump to the thing" feel users expect.
 *
 * Scoring tiers (so exact matches always rank above scattered subsequence hits):
 *   - prefix match   → highest, shorter text wins
 *   - substring match → high, earlier position wins
 *   - subsequence    → contiguity + early-position bonuses
 */
export function fuzzyMatch(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return 0;
  const t = text.toLowerCase();

  const idx = t.indexOf(q);
  if (idx === 0) return 1000 - text.length;
  if (idx > 0) return 600 - idx;

  let qi = 0;
  let score = 0;
  let prevMatch = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      if (prevMatch === ti - 1) score += 8; // contiguous run bonus
      score += Math.max(0, 12 - ti); // earlier matches score higher
      prevMatch = ti;
      qi++;
    }
  }
  if (qi < q.length) return null;
  return score;
}
