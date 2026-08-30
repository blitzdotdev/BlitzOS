/**
 * Copy `text` to the clipboard, returning whether it succeeded.
 *
 * Prefers the async Clipboard API and falls back to a hidden-`<textarea>` +
 * `document.execCommand('copy')` selection copy for insecure contexts and
 * browsers that reject `navigator.clipboard` (e.g. non-HTTPS, missing user
 * gesture). Safe to call in non-DOM environments — returns `false` instead of
 * throwing.
 *
 * Several components still keep local copies of this helper (e.g. the ai-gui
 * renderer/view); migrate them here when they are next touched.
 */
export const writeTextToClipboard = async (text: string): Promise<boolean> => {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the selection-based copy path below.
    }
  }

  if (typeof document === 'undefined') {
    return false;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';

  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
};
