/**
 * The BlitzOS browser: one iframe, an address bar, and the three kinds of
 * address `browser-target.ts` knows. It lives in Lody's side panel as our
 * `host:browser` tab (seam patch 19) and is what `blitz browser open` drives.
 *
 * History is the panel's own list of the addresses it was asked for — typed,
 * or raised by the box. A same-origin frame (a port or a file) also reports
 * where it went on every load, so the bar follows links inside the app; an
 * app frame is cross-origin and can only tell us through the one message the
 * teenyapp platform's bridge script posts, `blitz-browser:location`.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { isJsonObject, isJsonString, type JsonValue } from '@blitzos/schema';
import {
  browserAddress,
  browserFrameUrl,
  browserTargetFromFrameUrl,
  parseBrowserAddress,
  sameBrowserTarget,
  type BrowserTarget,
} from './browser-target';

/** What an embedded app posts to `window.parent` when its location changes. */
export const BROWSER_LOCATION_MESSAGE = 'blitz-browser:location';

export function BrowserPanel({
  target,
  filesBase,
  onNavigate,
}: {
  /** The address the panel shows, owned by the shell so it survives the tab
   * being switched away from and back. */
  target: BrowserTarget | null;
  /** The gateway's `/workspace/` base for this box, or null while it is not running. */
  filesBase: string | null;
  onNavigate: (target: BrowserTarget) => void;
}) {
  const [draft, setDraft] = useState(target === null ? '' : browserAddress(target));
  const [history, setHistory] = useState<BrowserTarget[]>(target === null ? [] : [target]);
  const [index, setIndex] = useState(target === null ? -1 : 0);
  const [reloads, setReloads] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  // Set before back/forward asks the shell for a target the history already
  // holds, so the effect below moves the cursor instead of pushing an entry.
  const pendingIndex = useRef<number | null>(null);

  useEffect(() => {
    setDraft(target === null ? '' : browserAddress(target));
    if (target === null) return;
    if (pendingIndex.current !== null) {
      setIndex(pendingIndex.current);
      pendingIndex.current = null;
      return;
    }
    if (sameBrowserTarget(history[index] ?? null, target)) return;
    const kept = history.slice(0, index + 1);
    setHistory([...kept, target]);
    setIndex(kept.length);
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps -- history follows the target alone

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      // A structured-clone payload from the frame; the bridge posts plain JSON.
      const data: JsonValue = event.data;
      if (!isJsonObject(data) || data.type !== BROWSER_LOCATION_MESSAGE) return;
      const href = data.href;
      if (href === undefined || !isJsonString(href)) return;
      setDraft(href);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const go = (step: number) => {
    const next = history[index + step];
    if (next === undefined) return;
    pendingIndex.current = index + step;
    onNavigate(next);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseBrowserAddress(draft);
    if (parsed !== null) onNavigate(parsed);
  };
  // A same-origin frame tells us where it really is; a cross-origin one throws
  // on the read, and the bridge message above is its channel instead.
  const followFrame = () => {
    if (filesBase === null) return;
    let href: string;
    try {
      href = frame.current?.contentWindow?.location.href ?? '';
    } catch {
      return;
    }
    const shown = browserTargetFromFrameUrl(href, filesBase);
    if (shown !== null) setDraft(browserAddress(shown));
  };

  const frameUrl = target === null || filesBase === null ? null : browserFrameUrl(target, filesBase);
  return (
    <div className="blitz-browser">
      <form className="blitz-browser__bar" onSubmit={submit}>
        <button type="button" aria-label="Back" disabled={index <= 0} onClick={() => go(-1)}>‹</button>
        <button type="button" aria-label="Forward" disabled={index >= history.length - 1} onClick={() => go(1)}>›</button>
        <button type="button" aria-label="Reload" disabled={frameUrl === null} onClick={() => setReloads((n) => n + 1)}>↻</button>
        <input
          className="blitz-browser__address"
          aria-label="Address"
          placeholder="a port, a file under /workspace, or an app URL"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          spellCheck={false}
        />
        {frameUrl !== null && (
          <a href={frameUrl} target="_blank" rel="noopener" aria-label="Open in a new tab">↗</a>
        )}
      </form>
      {target === null ? (
        <p className="blitz-browser__empty">
          Type an address above, or run <code>blitz browser open &lt;port|file|url&gt;</code> on the box.
        </p>
      ) : filesBase === null ? (
        <p className="blitz-browser__empty">The box is not running.</p>
      ) : frameUrl === null ? (
        <p className="blitz-browser__empty">
          {browserAddress(target)} is not a host this browser embeds.{' '}
          <a href={browserAddress(target)} target="_blank" rel="noopener">Open it in a new tab ↗</a>
        </p>
      ) : (
        <iframe
          key={`${frameUrl}#${reloads}`}
          ref={frame}
          className="blitz-browser__frame"
          src={frameUrl}
          title={browserAddress(target)}
          referrerPolicy="no-referrer"
          onLoad={followFrame}
        />
      )}
    </div>
  );
}
