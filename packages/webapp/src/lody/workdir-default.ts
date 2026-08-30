/**
 * The worktree pill's default, seeded rather than forced
 * (plans/LODY-SESSIONS.md §0.5, plans/LODY-RUNTIME-DESIGN.md §10.3).
 *
 * Upstream renders the pill `checked disabled` only in the `github` context —
 * the bare-mirror source BlitzOS does not use. A BlitzOS worktree session is the
 * `local` context, where the pill is a real toggle whose initial value comes from
 * `readWorkdirModePreference` (`lib/workdir-mode-preferences.ts:12`): the
 * per-project key first, then the global one, then `'local'`. And `'local'` means
 * the agent edits the `/workspace/<repo>` clone in place, which is not the
 * default this product wants.
 *
 * §0.5's ruling is to seed their own store instead of patching the component, so
 * this writes the GLOBAL key — the one upstream only ever reads, never writes —
 * and only when it is absent. That leaves both overrides intact: their own
 * per-project write (which is what ticking the pill off does) still wins, and a
 * member who sets the global key by hand is not overwritten on the next mount.
 */

/** `GLOBAL_WORKDIR_MODE_KEY` (`lib/workdir-mode-preferences.ts:4`). Inlined
 * rather than imported: it is not exported upstream. */
const GLOBAL_WORKDIR_MODE_KEY = "lody.workdirMode.global";

/** What a repo-backed session should default to. */
const WORKTREE_MODE = "worktree";

/** Writes the default once. Returns what the store holds afterwards, so a test
 * can assert the seed without reaching into `localStorage` itself. */
export function seedWorktreeWorkdirDefault(
  storage: Pick<Storage, "getItem" | "setItem"> = window.localStorage,
): string | null {
  try {
    const stored = storage.getItem(GLOBAL_WORKDIR_MODE_KEY);
    if (stored !== null) return stored;
    storage.setItem(GLOBAL_WORKDIR_MODE_KEY, WORKTREE_MODE);
    return WORKTREE_MODE;
  } catch {
    // Sandboxed storage. Their reader falls back to `'local'` for this mount,
    // which is the honest degradation: nothing is broken, the pill starts off.
    return null;
  }
}
