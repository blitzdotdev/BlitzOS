const BITCOUNT_FONT_LOAD_SPEC = '600 42px "Bitcount Grid Double"';
const FONT_READY_TIMEOUT_MS = 900;

let fontLoadPromise: Promise<boolean> | null = null;
let idlePreloadHandle: number | null = null;

function hasDocumentFonts(): boolean {
  return typeof document !== 'undefined' && 'fonts' in document;
}

async function loadUsageShareCardFonts(): Promise<boolean> {
  if (typeof document === 'undefined') return false;

  try {
    // This stays in its own Vite chunk. The Usage screen only requests it after idle time or a share action.
    await import('@fontsource/bitcount-grid-double/600.css');

    if (!hasDocumentFonts()) return true;
    await document.fonts.load(BITCOUNT_FONT_LOAD_SPEC);
    return document.fonts.check(BITCOUNT_FONT_LOAD_SPEC);
  } catch {
    // Canvas retains the configured fallback stack when a font chunk, CSP, or FontFace API is unavailable.
    return false;
  }
}

/** Start the single, cacheable Bitcount font request without making the caller wait. */
export function preloadUsageShareCardFonts(): Promise<boolean> {
  fontLoadPromise ??= loadUsageShareCardFonts();
  return fontLoadPromise;
}

/**
 * Begin loading after the Usage UI settles. A share action can still call
 * {@link waitForUsageShareCardFonts} and promote this work to the foreground.
 */
export function scheduleUsageShareCardFontPreload(): void {
  if (typeof window === 'undefined' || fontLoadPromise || idlePreloadHandle !== null) return;

  const start = () => {
    idlePreloadHandle = null;
    void preloadUsageShareCardFonts();
  };

  if (typeof window.requestIdleCallback === 'function') {
    idlePreloadHandle = window.requestIdleCallback(start, { timeout: 2_000 });
  } else {
    idlePreloadHandle = window.setTimeout(start, 300);
  }
}

/**
 * Prefer Bitcount for a generated card, but never hold the preview or export
 * hostage to a slow connection. The underlying request continues for future cards.
 */
export async function waitForUsageShareCardFonts(
  timeoutMs = FONT_READY_TIMEOUT_MS
): Promise<boolean> {
  if (typeof window === 'undefined') return false;

  const fontPromise = preloadUsageShareCardFonts();
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (loaded: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      resolve(loaded);
    };
    const timeout = window.setTimeout(() => finish(false), timeoutMs);
    void fontPromise.then(finish, () => finish(false));
  });
}
