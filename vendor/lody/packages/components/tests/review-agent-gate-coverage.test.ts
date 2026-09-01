import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Structural guard for the review agent experiment gate.
 *
 * Cloned from the Tasks gate for the same reason it exists there: the gate only
 * holds if every surface outside the feature reads it, and a leaked entry point
 * fails silently — the feature works, the tests pass, and a user who never
 * opted in simply sees a control that offers to merge their branch.
 *
 * The stakes are higher here than for Tasks. A leaked Tasks door shows a board;
 * a leaked door here shows a switch whose whole job is to merge code without
 * asking again.
 *
 * If this fails on a file you just added, wire the gate rather than widening the
 * exemptions.
 */

const SRC = join(__dirname, '..', 'src');
const GATE_ATOM = 'reviewAgentFeatureEnabledAtom';

/**
 * The menu item reads the gate itself and renders nothing when it is off, so a
 * host that only mounts it has delegated the check rather than skipped it. This
 * mirrors how the Tasks gate accepts its route guard.
 */
const GATED_COMPONENT = 'AutoReviewMenuItem';

/**
 * Imports that mean "this file can START a run".
 *
 * `auto-review-status` is deliberately NOT here. It reports a run that is
 * already authorized, and an authorized run keeps going on the machine whatever
 * this device's switches say. Gating the status display would mean a user who
 * turned the experiment off still had branches merging themselves with nothing
 * on screen saying so — the precise failure the banner exists to prevent. What
 * must be gated is the ability to start one, not the ability to see one.
 */
// Matches both the aliased and the relative import form: siblings inside
// `components/sessions/` import these as `./auto-review-menu-item`.
const REVIEW_IMPORT_PATTERNS = [
  /from\s+['"][^'"]*auto-review-menu-item['"]/,
  /from\s+['"][^'"]*auto-review-info['"]/,
  /from\s+['"][^'"]*atoms\/review-policy['"]/,
];

/**
 * Interior of the feature: these only run beneath a surface that already checked
 * the gate, so re-reading the atom inside them would be noise.
 */
function isFeatureInterior(relPath: string): boolean {
  const p = relPath.split(sep).join('/');
  return (
    p.startsWith('components/sessions/auto-review-') ||
    p === 'hooks/use-auto-review.ts' ||
    p === 'atoms/review-policy.ts' ||
    // Reads the gate itself to decide whether to render the policy rows.
    p === 'components/settings/review-policy-setting.tsx' ||
    p.startsWith('stories/')
  );
}

/** Type-only imports vanish at runtime, so they cannot put a surface on screen. */
function withoutTypeOnlyImports(source: string): string {
  return source.replace(/import\s+type\s+[\s\S]*?from\s+['"][^'"]+['"];?/g, '');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('review agent gate coverage', () => {
  const files = walk(SRC).map((full) => ({
    rel: relative(SRC, full).split(sep).join('/'),
    source: readFileSync(full, 'utf8'),
  }));

  const reachesIntoReview = files.filter((f) => {
    if (isFeatureInterior(f.rel)) return false;
    return REVIEW_IMPORT_PATTERNS.some((re) => re.test(withoutTypeOnlyImports(f.source)));
  });

  it('finds the known entry points (guards against the scan matching nothing)', () => {
    expect(reachesIntoReview.length).toBeGreaterThanOrEqual(1);
  });

  it('gates every surface outside the feature', () => {
    const ungated = reachesIntoReview
      .filter((f) => !f.source.includes(GATE_ATOM) && !f.source.includes(GATED_COMPONENT))
      .map((f) => f.rel);

    expect(
      ungated,
      `These files reach into the review agent without reading ${GATE_ATOM}. Wire the gate — ` +
        'an entry point that skips it offers automatic merging to users who never opted in.'
    ).toEqual([]);
  });

  it('gates the control that can start a run', () => {
    const menuItem = files.find(
      (f) => f.rel === 'components/sessions/auto-review-menu-item.tsx'
    );
    expect(menuItem).toBeDefined();
    expect(
      menuItem?.source,
      'The menu item is the only way to authorize a run, so it must read the gate.'
    ).toContain(GATE_ATOM);
  });

  it('does not gate the status banner, so an active run stays visible', () => {
    // Turning the experiment off must not hide a branch that is still being
    // reviewed and merged; the run lives on the machine, not on this device.
    const status = files.find((f) => f.rel === 'components/sessions/auto-review-status.tsx');
    expect(status).toBeDefined();
    expect(status?.source).not.toContain(GATE_ATOM);
  });

  it('keeps the durable authorization out of the per-device gate', () => {
    // The checkbox is `SessionMeta.autoReview`, which the machine reads
    // headlessly. If the gate atom were the authorization, closing the browser
    // or switching devices would silently strand a branch the user was told
    // would be merged.
    const hook = files.find((f) => f.rel === 'hooks/use-auto-review.ts');
    expect(hook).toBeDefined();
    expect(hook?.source).not.toContain(GATE_ATOM);
    expect(hook?.source).toContain('autoReview');
  });
});
